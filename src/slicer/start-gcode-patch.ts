/**
 * Per-server machine start G-code insertion for Bambu-compatible CLI slicing.
 *
 * The machine preset owns machine_start_gcode (see isolateMachineSettings in
 * bambu-cli.ts), so a template or process profile cannot add printer-specific
 * hardware steps such as a nozzle wiper pass. A server that drives one physical
 * printer can opt in through its environment:
 *
 *   BAMBU_START_GCODE_INSERT_FILE           snippet to insert (enables the hook)
 *   BAMBU_START_GCODE_INSERT_BEFORE         exact start G-code line to insert before
 *   BAMBU_START_GCODE_INSERT_SECTION_START  optional: anchor must follow this section marker
 *   BAMBU_START_GCODE_INSERT_SECTION_END    optional: ...and precede this one
 *   BAMBU_START_GCODE_INSERT_PRESETS        optional: ';'-separated machine presets allowed
 *
 * Only machine_start_gcode changes. Every validation failure throws, so the
 * slice stops instead of silently producing stock G-code.
 */

import fs from "node:fs";
import crypto from "node:crypto";

export const START_GCODE_PATCH_ENV = {
  file: "BAMBU_START_GCODE_INSERT_FILE",
  before: "BAMBU_START_GCODE_INSERT_BEFORE",
  sectionStart: "BAMBU_START_GCODE_INSERT_SECTION_START",
  sectionEnd: "BAMBU_START_GCODE_INSERT_SECTION_END",
  presets: "BAMBU_START_GCODE_INSERT_PRESETS",
} as const;

export interface StartGcodePatchConfig {
  file: string;
  anchor: string;
  sectionStart?: string;
  sectionEnd?: string;
  presets?: string[];
}

export interface StartGcodePatchReport {
  status: "inserted" | "already-present";
  file: string;
  sha256: string;
  anchor: string;
  /** First non-empty snippet line, used as the idempotency marker. */
  marker: string;
  preset: string;
  snippetLines: number;
  /** 1-based machine_start_gcode line of the snippet's first line. */
  startLine: number;
}

function envValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key];
  return value !== undefined && value.trim() !== "" ? value.trim() : undefined;
}

/**
 * Read the opt-in configuration. Returns undefined when the hook is off.
 * A partial configuration (for example an anchor without a file) throws.
 */
export function startGcodePatchConfigFromEnv(env: NodeJS.ProcessEnv = process.env): StartGcodePatchConfig | undefined {
  const file = envValue(env, START_GCODE_PATCH_ENV.file);
  // The anchor is compared as a whole line, so keep inner spacing but ignore
  // surrounding whitespace the same way the line comparison does.
  const anchor = envValue(env, START_GCODE_PATCH_ENV.before);
  const sectionStart = envValue(env, START_GCODE_PATCH_ENV.sectionStart);
  const sectionEnd = envValue(env, START_GCODE_PATCH_ENV.sectionEnd);
  const presetsRaw = envValue(env, START_GCODE_PATCH_ENV.presets);
  if (!file) {
    const stray = [anchor, sectionStart, sectionEnd, presetsRaw].some((value) => value !== undefined);
    if (stray) {
      throw new Error(
        `${START_GCODE_PATCH_ENV.file} is not set, but other BAMBU_START_GCODE_INSERT_* variables are; ` +
        "refusing to slice with a partial start G-code patch configuration."
      );
    }
    return undefined;
  }
  if (!anchor) {
    throw new Error(
      `${START_GCODE_PATCH_ENV.file} is set but ${START_GCODE_PATCH_ENV.before} is empty; ` +
      "set it to the exact start G-code line the snippet must precede."
    );
  }
  if ((sectionStart === undefined) !== (sectionEnd === undefined)) {
    throw new Error(
      `Set both ${START_GCODE_PATCH_ENV.sectionStart} and ${START_GCODE_PATCH_ENV.sectionEnd}, or neither.`
    );
  }
  const presets = presetsRaw?.split(";").map((name) => name.trim()).filter(Boolean);
  return {
    file,
    anchor,
    ...(sectionStart ? { sectionStart, sectionEnd } : {}),
    ...(presets && presets.length > 0 ? { presets } : {}),
  };
}

const normalizeLine = (line: string) => line.replace(/\r$/, "").trim();

/** Snippet lines with CRLF normalized and leading/trailing blank lines removed. */
function readSnippet(config: StartGcodePatchConfig): { lines: string[]; sha256: string } {
  let raw: string;
  try {
    raw = fs.readFileSync(config.file, "utf8");
  } catch (error: any) {
    throw new Error(`cannot read snippet ${config.file}: ${error?.code ?? error?.message ?? error}`);
  }
  const lines = raw.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split("\n");
  while (lines.length > 0 && lines[0].trim() === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  if (lines.length === 0) throw new Error(`snippet ${config.file} is empty`);
  if (lines.some((line) => normalizeLine(line) === config.anchor)) {
    throw new Error(`snippet ${config.file} itself contains the anchor line "${config.anchor}"`);
  }
  return { lines, sha256: crypto.createHash("sha256").update(lines.join("\n")).digest("hex") };
}

/**
 * Insert the configured snippet into a resolved machine preset's
 * machine_start_gcode. Returns a new machine object; the input is not mutated.
 */
export function applyStartGcodePatch(
  machine: Record<string, unknown>,
  preset: string,
  config: StartGcodePatchConfig
): { machine: Record<string, unknown>; report: StartGcodePatchReport } {
  const fail = (reason: string): never => {
    throw new Error(
      `Start G-code patch (${START_GCODE_PATCH_ENV.file}=${config.file}) cannot be applied to "${preset}": ${reason}. ` +
      "Refusing to slice without it."
    );
  };
  if (config.presets && !config.presets.includes(preset)) {
    fail(`this server only allows it for ${config.presets.map((name) => `"${name}"`).join(", ")} ` +
      `(${START_GCODE_PATCH_ENV.presets})`);
  }
  let snippet: { lines: string[]; sha256: string };
  try {
    snippet = readSnippet(config);
  } catch (error: any) {
    return fail(error?.message ?? String(error));
  }
  const marker = normalizeLine(snippet.lines.find((line) => line.trim() !== "")!);
  const gcode = machine.machine_start_gcode;
  if (typeof gcode !== "string") {
    fail(`the resolved preset has no machine_start_gcode string (found ${gcode === undefined ? "none" : typeof gcode})`);
  }
  const lines = (gcode as string).split("\n");
  const baseReport = {
    file: config.file, sha256: snippet.sha256, anchor: config.anchor, marker, preset, snippetLines: snippet.lines.length,
  };

  const markerLines = lines.flatMap((line, index) => (normalizeLine(line) === marker ? [index] : []));
  if (markerLines.length > 1) {
    fail(`its first line "${marker}" already appears ${markerLines.length} times in machine_start_gcode`);
  }
  if (markerLines.length === 1) {
    // Idempotent: a preset (or an earlier pass) that already carries the whole
    // snippet is left alone instead of receiving a second copy. A lone match
    // of the first line is ambiguous (for example a generic "G90"), so stop.
    const at = markerLines[0];
    const complete = snippet.lines.every((line, i) => lines[at + i] !== undefined && normalizeLine(lines[at + i]) === normalizeLine(line));
    if (!complete) {
      fail(`its first line "${marker}" already appears in machine_start_gcode without the rest of the snippet; ` +
        "start the snippet with a unique comment line");
    }
    return { machine: { ...machine }, report: { ...baseReport, status: "already-present", startLine: at + 1 } };
  }

  const anchors = lines.flatMap((line, index) => (normalizeLine(line) === config.anchor ? [index] : []));
  if (anchors.length !== 1) {
    fail(`anchor line "${config.anchor}" appears ${anchors.length} times in machine_start_gcode, expected exactly once`);
  }
  const at = anchors[0];
  if (config.sectionStart && config.sectionEnd) {
    const isStart = (index: number) => normalizeLine(lines[index]).startsWith(config.sectionStart!);
    const isEnd = (index: number) => normalizeLine(lines[index]).startsWith(config.sectionEnd!);
    let start = -1;
    for (let i = at - 1; i >= 0; i--) {
      if (isEnd(i)) break;
      if (isStart(i)) { start = i; break; }
    }
    let end = -1;
    for (let i = at + 1; i < lines.length; i++) {
      if (isStart(i)) break;
      if (isEnd(i)) { end = i; break; }
    }
    if (start < 0 || end < 0) {
      fail(`anchor line "${config.anchor}" is not inside the "${config.sectionStart}" ... "${config.sectionEnd}" section`);
    }
  }
  // Keep the preset's own line endings for the inserted lines.
  const eol = lines[at].endsWith("\r") ? "\r" : "";
  const patched = [...lines.slice(0, at), ...snippet.lines.map((line) => line + eol), ...lines.slice(at)].join("\n");
  return {
    machine: { ...machine, machine_start_gcode: patched },
    report: { ...baseReport, status: "inserted", startLine: at + 1 },
  };
}

/** One-line description for logs and tool results. */
export function describeStartGcodePatch(report: StartGcodePatchReport): string {
  const what = report.status === "inserted"
    ? `inserted ${report.snippetLines} line(s) at machine_start_gcode line ${report.startLine}, before "${report.anchor}"`
    : `already present at machine_start_gcode line ${report.startLine}; not inserted again`;
  return `Start G-code patch applied to "${report.preset}": ${what} ` +
    `(file ${report.file}, sha256 ${report.sha256.slice(0, 12)}, marker "${report.marker}").`;
}
