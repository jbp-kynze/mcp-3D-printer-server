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
  /** Normalized snippet lines, used to verify the sliced output. */
  snippet: string[];
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
    snippet: snippet.lines.map(normalizeLine),
  };

  const anchors = lines.flatMap((line, index) => (normalizeLine(line) === config.anchor ? [index] : []));
  if (anchors.length !== 1) {
    fail(`anchor line "${config.anchor}" appears ${anchors.length} times in machine_start_gcode, expected exactly once`);
  }
  const at = anchors[0];
  let sectionStartLine = -1;
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
    sectionStartLine = start;
  }
  const markerLines = lines.flatMap((line, index) => (normalizeLine(line) === marker ? [index] : []));
  if (markerLines.length > 1) {
    fail(`its first line "${marker}" already appears ${markerLines.length} times in machine_start_gcode`);
  }
  if (markerLines.length === 1) {
    // Idempotent: a preset (or an earlier pass) that already carries the whole
    // snippet directly before the anchor (inside the section, checked above)
    // is left alone instead of receiving a second copy. A lone match of the
    // first line (for example a generic "G90"), or a copy elsewhere, stops.
    const first = markerLines[0];
    const complete = snippet.lines.every((line, i) => lines[first + i] !== undefined && normalizeLine(lines[first + i]) === normalizeLine(line));
    if (!complete) {
      fail(`its first line "${marker}" already appears in machine_start_gcode without the rest of the snippet; ` +
        "start the snippet with a unique comment line");
    }
    if (first + snippet.lines.length !== at) {
      fail(`the snippet is already in machine_start_gcode at line ${first + 1}, but not directly before the anchor line "${config.anchor}"`);
    }
    if (first <= sectionStartLine) {
      fail(`the snippet already in machine_start_gcode at line ${first + 1} starts outside the "${config.sectionStart}" section`);
    }
    return { machine: { ...machine }, report: { ...baseReport, status: "already-present", startLine: first + 1 } };
  }

  // Keep the preset's own line endings for the inserted lines.
  const eol = lines[at].endsWith("\r") ? "\r" : "";
  const patched = [...lines.slice(0, at), ...snippet.lines.map((line) => line + eol), ...lines.slice(at)].join("\n");
  return {
    machine: { ...machine, machine_start_gcode: patched },
    report: { ...baseReport, status: "inserted", startLine: at + 1 },
  };
}

const isProgressLine = (line: string) => /^M73(\s|$)/i.test(line);
const isLayerChange = (line: string) => line === "; CHANGE_LAYER" || line === ";LAYER_CHANGE";

/**
 * Check one sliced plate's G-code: the snippet's first line is a real G-code
 * line exactly once (the "; machine_start_gcode = " settings dump is a single
 * comment line and never matches), it lies in the start G-code before the
 * first layer change, its last line is directly followed by the anchor (M73
 * progress lines the slicer inserts are skipped), and the
 * "; change_filament_gcode = " dump does not contain it.
 */
export function verifyStartGcodePatchInPlate(gcode: string, report: StartGcodePatchReport): void {
  const lines = gcode.split(/\r?\n/).map(normalizeLine);
  const starts = lines.flatMap((line, index) => (line === report.marker ? [index] : []));
  if (starts.length !== 1) {
    throw new Error(`its first line "${report.marker}" appears ${starts.length} times as a G-code line, expected exactly once`);
  }
  const first = starts[0];
  const firstLayer = lines.findIndex(isLayerChange);
  if (firstLayer >= 0 && first > firstLayer) {
    throw new Error(`its first line "${report.marker}" is after the first layer change, not in the start G-code`);
  }
  // Walk the snippet's lines in order, skipping the slicer's progress lines.
  let cursor = first;
  const next = () => {
    cursor++;
    while (cursor < lines.length && isProgressLine(lines[cursor])) cursor++;
    return cursor < lines.length ? lines[cursor] : undefined;
  };
  for (let i = 1; i < report.snippet.length; i++) next();
  const last = report.snippet[report.snippet.length - 1];
  if (cursor >= lines.length || lines[cursor] !== last) {
    throw new Error(`its last line "${last}" is not where the ${report.snippetLines}-line snippet should end`);
  }
  const following = next();
  if (following !== report.anchor) {
    throw new Error(`its last line is followed by "${following ?? "(end of file)"}" instead of the anchor line "${report.anchor}"`);
  }
  const changeFilament = lines.find((line) => line.startsWith("; change_filament_gcode = "));
  if (changeFilament?.includes(report.marker)) {
    throw new Error("change_filament_gcode contains the snippet");
  }
}

/**
 * Open a sliced Bambu 3MF and verify every nonempty plate G-code carries the
 * applied snippet exactly where it was inserted. Throws (fail closed) otherwise.
 */
export async function verifyStartGcodePatchInSlicedProject(outputPath: string, report: StartGcodePatchReport): Promise<string[]> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(await fs.promises.readFile(outputPath));
  const plates = Object.values(zip.files)
    .filter((entry) => !entry.dir && /^Metadata\/plate_\d+\.gcode$/i.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  const checked: string[] = [];
  const fail = (where: string, reason: string): never => {
    throw new Error(
      `Start G-code patch (${START_GCODE_PATCH_ENV.file}=${report.file}) is not correctly present in the sliced output ` +
      `${where}: ${reason}. Refusing to use this slice.`
    );
  };
  for (const entry of plates) {
    const gcode = await entry.async("string");
    if (gcode.length === 0) continue;
    try {
      verifyStartGcodePatchInPlate(gcode, report);
    } catch (error: any) {
      fail(entry.name, error?.message ?? String(error));
    }
    checked.push(entry.name);
  }
  if (checked.length === 0) fail(outputPath, "it has no sliced plate G-code to check");
  const settings = zip.file("Metadata/project_settings.config");
  if (settings) {
    let config: any;
    try {
      config = JSON.parse(await settings.async("string"));
    } catch {
      config = undefined;
    }
    const value = config?.change_filament_gcode;
    const text = Array.isArray(value) ? value.join("\n") : typeof value === "string" ? value : "";
    if (text.split(/\r?\n/).some((line: string) => normalizeLine(line) === report.marker)) {
      fail("Metadata/project_settings.config", "change_filament_gcode contains the snippet");
    }
  }
  return checked;
}

/** One-line description for logs and tool results. */
export function describeStartGcodePatch(report: StartGcodePatchReport): string {
  const what = report.status === "inserted"
    ? `inserted ${report.snippetLines} line(s) at machine_start_gcode line ${report.startLine}, before "${report.anchor}"`
    : `already present at machine_start_gcode line ${report.startLine}; not inserted again`;
  return `Start G-code patch applied to "${report.preset}": ${what} ` +
    `(file ${report.file}, sha256 ${report.sha256.slice(0, 12)}, marker "${report.marker}").`;
}
