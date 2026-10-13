// Per-server machine start G-code insertion (BAMBU_START_GCODE_INSERT_*).
// Profiles are prepared in a synthetic BBL tree; no slicer runs and no
// printer is contacted (print_3mf uses stubbed Bambu transport boundaries).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import JSZip from "jszip";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  applyStartGcodePatch,
  startGcodePatchConfigFromEnv,
  verifyStartGcodePatchInPlate,
  verifyStartGcodePatchInSlicedProject,
} from "../../dist/slicer/start-gcode-patch.js";
import { BambuCliProfilePreparer } from "../../dist/slicer/bambu-cli.js";
import { STLManipulator } from "../../dist/stl/stl-manipulator.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PRESET = "Bambu Lab P1S 0.4 nozzle";
const ANCHOR = "M221 R; pop softend status";
const SECTION_START = ";===== wipe nozzle =====";
const SECTION_END = ";===== wipe nozzle end";
const MARKER = ";===== Start of Test Wipe";
const SNIPPET = `${MARKER}\r\nG90\r\nG1 Z10 F1200\r\n;===== End of Test Wipe\r\n`;
const START_GCODE = [
  ";===== machine: P1S =====",
  "G28",
  ";===== wipe nozzle ===============================",
  "G2 I0.5 J0 F3000",
  "",
  ANCHOR,
  "G1 Z10 F1200",
  ";===== wipe nozzle end ================================",
  "M400",
].join("\n");
const CHANGE_FILAMENT = `M620 S[next_extruder]A\n${ANCHOR}\nM621 S[next_extruder]A`;
const PATCH_KEYS = [
  "BAMBU_START_GCODE_INSERT_FILE", "BAMBU_START_GCODE_INSERT_BEFORE", "BAMBU_START_GCODE_INSERT_SECTION_START",
  "BAMBU_START_GCODE_INSERT_SECTION_END", "BAMBU_START_GCODE_INSERT_PRESETS",
];

async function tempDir(t, prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function snippetFile(t, content = SNIPPET) {
  const file = path.join(await tempDir(t, "start-gcode-snippet-"), "wipe.gcode");
  await fs.writeFile(file, content);
  return file;
}

const machine = (startGcode = START_GCODE) => ({
  name: PRESET, machine_start_gcode: startGcode, change_filament_gcode: CHANGE_FILAMENT, machine_end_gcode: "M400",
});

/** A P1S-shaped BBL tree with inherits/include like the real bundle. */
async function profileTree(t, startGcode = START_GCODE) {
  const root = await tempDir(t, "start-gcode-tree-");
  const profiles = path.join(root, "profiles");
  const bbl = path.join(profiles, "BBL");
  for (const kind of ["machine", "process", "filament"]) await fs.mkdir(path.join(bbl, kind), { recursive: true });
  const write = async (kind, value) => {
    const file = path.join(bbl, kind, `${value.name}.json`);
    await fs.writeFile(file, JSON.stringify(value));
    return file;
  };
  await fs.writeFile(path.join(bbl, "cli_config.json"), JSON.stringify({
    printer: { "Bambu Lab P1S": { downward_check: { [PRESET]: ["Bambu Lab P1P 0.4 nozzle"] } } },
  }));
  await write("machine", { name: "fdm_machine_common", from: "system", instantiation: "false", nozzle_diameter: ["0.4"] });
  await write("machine", { name: "P1S template change_filament_gcode", from: "system", instantiation: "false",
    change_filament_gcode: CHANGE_FILAMENT });
  await write("machine", { name: PRESET, inherits: "fdm_machine_common", include: ["P1S template change_filament_gcode"],
    from: "system", instantiation: "true", printer_model: "Bambu Lab P1S", printer_variant: "0.4",
    default_print_profile: "0.20mm Standard @BBL P1S", default_filament_profile: ["Bambu PLA Basic @BBL P1S"],
    machine_start_gcode: startGcode });
  await write("process", { name: "0.20mm Standard @BBL P1S", from: "system", instantiation: "true", layer_height: "0.2" });
  await write("filament", { name: "Bambu PLA Basic @BBL P1S", from: "system", instantiation: "true",
    filament_type: ["PLA"], nozzle_temperature: ["220"] });
  return { root, profiles, bbl };
}

function withEnv(t, values) {
  const keys = [...PATCH_KEYS, "BAMBU_PROFILES_ROOT", "BAMBU_SLICER_PROFILE_DIRS", "BAMBU_CLI_FLATTEN"];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  for (const key of keys) delete process.env[key];
  Object.assign(process.env, values);
}

const readJson = async (file) => JSON.parse(await fs.readFile(file, "utf8"));

test("the hook is off when no BAMBU_START_GCODE_INSERT_* variable is set (or all are empty)", () => {
  assert.equal(startGcodePatchConfigFromEnv({}), undefined);
  assert.equal(startGcodePatchConfigFromEnv(Object.fromEntries(PATCH_KEYS.map((key) => [key, " "]))), undefined);
});

test("partial configurations are rejected instead of silently disabling the hook", () => {
  assert.throws(() => startGcodePatchConfigFromEnv({ BAMBU_START_GCODE_INSERT_BEFORE: ANCHOR }), /INSERT_FILE is not set/);
  assert.throws(() => startGcodePatchConfigFromEnv({ BAMBU_START_GCODE_INSERT_FILE: "wipe.gcode" }), /INSERT_BEFORE is empty/);
  assert.throws(() => startGcodePatchConfigFromEnv({
    BAMBU_START_GCODE_INSERT_FILE: "wipe.gcode", BAMBU_START_GCODE_INSERT_BEFORE: ANCHOR,
    BAMBU_START_GCODE_INSERT_SECTION_START: SECTION_START,
  }), /both .*SECTION_START and .*SECTION_END/);
  assert.deepEqual(startGcodePatchConfigFromEnv({
    BAMBU_START_GCODE_INSERT_FILE: "wipe.gcode", BAMBU_START_GCODE_INSERT_BEFORE: ` ${ANCHOR} `,
    BAMBU_START_GCODE_INSERT_PRESETS: `${PRESET}; Bambu Lab P1S 0.6 nozzle;`,
  }), { file: "wipe.gcode", anchor: ANCHOR, presets: [PRESET, "Bambu Lab P1S 0.6 nozzle"] });
});

test("the snippet is inserted directly before the anchor and nothing else changes", async (t) => {
  const file = await snippetFile(t);
  const input = machine();
  const { machine: patched, report } = applyStartGcodePatch(input, PRESET, {
    file, anchor: ANCHOR, sectionStart: SECTION_START, sectionEnd: SECTION_END,
  });
  const lines = patched.machine_start_gcode.split("\n");
  const at = lines.indexOf(ANCHOR);
  assert.deepEqual(lines.slice(at - 4, at), [MARKER, "G90", "G1 Z10 F1200", ";===== End of Test Wipe"]);
  assert.equal(lines.filter((line) => line === MARKER).length, 1);
  assert.equal(patched.machine_start_gcode.includes("\r"), false, "CRLF snippets are normalized to the preset's LF");
  assert.equal(patched.change_filament_gcode, CHANGE_FILAMENT, "change_filament_gcode must never be patched");
  assert.deepEqual({ ...patched, machine_start_gcode: undefined }, { ...input, machine_start_gcode: undefined });
  assert.equal(input.machine_start_gcode, START_GCODE, "the input object is not mutated");
  assert.equal(report.status, "inserted");
  assert.equal(report.startLine, START_GCODE.split("\n").indexOf(ANCHOR) + 1);
  assert.equal(report.marker, MARKER);
  assert.equal(report.snippetLines, 4);
  assert.match(report.sha256, /^[0-9a-f]{64}$/);
});

test("a missing anchor fails closed", async (t) => {
  const file = await snippetFile(t);
  assert.throws(
    () => applyStartGcodePatch(machine(START_GCODE.replace(ANCHOR, "M221 R")), PRESET, { file, anchor: ANCHOR }),
    /anchor line "M221 R; pop softend status" appears 0 times.*Refusing to slice/s
  );
});

test("a duplicated anchor fails closed", async (t) => {
  const file = await snippetFile(t);
  assert.throws(
    () => applyStartGcodePatch(machine(`${START_GCODE}\n${ANCHOR}`), PRESET, { file, anchor: ANCHOR }),
    /appears 2 times in machine_start_gcode, expected exactly once/
  );
});

test("the anchor must be a whole line, not a substring of another line", async (t) => {
  const file = await snippetFile(t);
  assert.throws(
    () => applyStartGcodePatch(machine(START_GCODE.replace(ANCHOR, `;${ANCHOR}`)), PRESET, { file, anchor: ANCHOR }),
    /appears 0 times/
  );
});

test("an anchor outside the configured section fails closed", async (t) => {
  const file = await snippetFile(t);
  const outside = START_GCODE.replace(`${ANCHOR}\n`, "").replace("M400", `M400\n${ANCHOR}`);
  assert.throws(
    () => applyStartGcodePatch(machine(outside), PRESET, { file, anchor: ANCHOR, sectionStart: SECTION_START, sectionEnd: SECTION_END }),
    /is not inside the ";===== wipe nozzle =====" \.\.\. ";===== wipe nozzle end" section/
  );
});

test("a missing, empty, or anchor-containing snippet fails closed", async (t) => {
  const dir = await tempDir(t, "start-gcode-bad-");
  assert.throws(() => applyStartGcodePatch(machine(), PRESET, { file: path.join(dir, "missing.gcode"), anchor: ANCHOR }),
    /cannot read snippet .*missing\.gcode: ENOENT.*Refusing to slice/s);
  const empty = await snippetFile(t, "\r\n\n");
  assert.throws(() => applyStartGcodePatch(machine(), PRESET, { file: empty, anchor: ANCHOR }), /is empty/);
  const withAnchor = await snippetFile(t, `G90\n${ANCHOR}\n`);
  assert.throws(() => applyStartGcodePatch(machine(), PRESET, { file: withAnchor, anchor: ANCHOR }),
    /itself contains the anchor line/);
});

test("a preset outside BAMBU_START_GCODE_INSERT_PRESETS fails closed", async (t) => {
  const file = await snippetFile(t);
  assert.throws(
    () => applyStartGcodePatch(machine(), PRESET, { file, anchor: ANCHOR, presets: ["Bambu Lab X1 Carbon 0.4 nozzle"] }),
    /only allows it for "Bambu Lab X1 Carbon 0.4 nozzle"/
  );
});

test("a preset without an inline start G-code string fails closed", async (t) => {
  const file = await snippetFile(t);
  const { machine_start_gcode, ...rest } = machine();
  assert.throws(() => applyStartGcodePatch(rest, PRESET, { file, anchor: ANCHOR }), /no machine_start_gcode string/);
});

test("insertion is idempotent: a preset that already carries the snippet is not patched again", async (t) => {
  const file = await snippetFile(t);
  const config = { file, anchor: ANCHOR, sectionStart: SECTION_START, sectionEnd: SECTION_END };
  const once = applyStartGcodePatch(machine(), PRESET, config);
  const twice = applyStartGcodePatch(once.machine, PRESET, config);
  assert.equal(twice.machine.machine_start_gcode, once.machine.machine_start_gcode);
  assert.equal(twice.report.status, "already-present");
  assert.equal(twice.report.startLine, once.report.startLine);
  // Two copies of the marker cannot be resolved safely.
  const doubled = `${once.machine.machine_start_gcode}\n${MARKER}`;
  assert.throws(() => applyStartGcodePatch(machine(doubled), PRESET, config), /already appears 2 times/);
  // An existing copy that is not directly before the anchor is not accepted as applied.
  const snippetBlock = once.machine.machine_start_gcode.split("\n").slice(once.report.startLine - 1, once.report.startLine + 3);
  const misplaced = [snippetBlock.join("\n"), START_GCODE].join("\n");
  assert.throws(() => applyStartGcodePatch(machine(misplaced), PRESET, config),
    /already in machine_start_gcode at line 1, but not directly before the anchor line/);
  const separated = once.machine.machine_start_gcode.replace(`;===== End of Test Wipe\n${ANCHOR}`, `;===== End of Test Wipe\nG4 P0\n${ANCHOR}`);
  assert.throws(() => applyStartGcodePatch(machine(separated), PRESET, config), /not directly before the anchor line/);
  // An existing copy directly before the anchor still needs the anchor inside the section.
  const outsideSection = [";===== machine: P1S =====", ...snippetBlock, ANCHOR, "M400"].join("\n");
  assert.throws(() => applyStartGcodePatch(machine(outsideSection), PRESET, config), /is not inside the ";===== wipe nozzle =====" \.\.\. ";===== wipe nozzle end" section/);
  assert.equal(applyStartGcodePatch(machine(outsideSection), PRESET, { file, anchor: ANCHOR }).report.status, "already-present",
    "without a section guard the same placement is accepted");
  // An existing copy that starts before the section marker is rejected.
  const markerSnippet = await snippetFile(t, `${MARKER}\n${SECTION_START} (snippet)\nG90\n`);
  const straddling = [";===== machine: P1S =====", MARKER, `${SECTION_START} (snippet)`, "G90", ANCHOR, SECTION_END].join("\n");
  assert.throws(() => applyStartGcodePatch(machine(straddling), PRESET, { ...config, file: markerSnippet }), /starts outside the ";===== wipe nozzle =====" section/);
  // A first line that matches without the rest of the snippet is ambiguous.
  const generic = await snippetFile(t, "G28\nG1 Z10 F1200\n");
  assert.throws(() => applyStartGcodePatch(machine(), PRESET, { ...config, file: generic }),
    /first line "G28" already appears in machine_start_gcode without the rest of the snippet/);
});

test("prepare patches only the resolved machine preset, before process/filament isolation", async (t) => {
  const tree = await profileTree(t);
  withEnv(t, { BAMBU_PROFILES_ROOT: tree.profiles, BAMBU_SLICER_PROFILE_DIRS: "" });
  const file = await snippetFile(t);
  // A template-derived process that carries its own (stock) start G-code must not win.
  const processFile = path.join(tree.root, "template_process.json");
  await fs.writeFile(processFile, JSON.stringify({ name: "Template", inherits: "0.20mm Standard @BBL P1S",
    machine_start_gcode: ";===== process start gcode =====", layer_height: "0.16" }));
  const input = path.join(tree.root, "model.stl");
  await fs.writeFile(input, "solid fixture");
  for (const slicerType of ["bambustudio", "orcaslicer"]) {
    const preparer = new BambuCliProfilePreparer(path.join(tree.root, `prepared-${slicerType}`), {
      startGcodePatch: { file, anchor: ANCHOR, sectionStart: SECTION_START, sectionEnd: SECTION_END },
    });
    const bundle = await preparer.prepare(input, "model", slicerType, tree.profiles, PRESET, processFile, {});
    const [machinePath, processPath] = bundle.settingsArg.split(";");
    const prepared = await readJson(machinePath);
    const lines = prepared.machine_start_gcode.split("\n");
    assert.equal(lines.filter((line) => line === MARKER).length, 1, slicerType);
    assert.equal(lines[lines.indexOf(ANCHOR) - 1], ";===== End of Test Wipe", slicerType);
    assert.equal(prepared.change_filament_gcode, CHANGE_FILAMENT, `${slicerType}: change_filament_gcode untouched`);
    const processProfile = await readJson(processPath);
    assert.equal(processProfile.machine_start_gcode, undefined, `${slicerType}: the process cannot replace the patched start G-code`);
    assert.equal(processProfile.layer_height, "0.16");
    for (const filamentPath of bundle.filamentPaths) {
      assert.equal(JSON.stringify(await readJson(filamentPath)).includes(MARKER), false);
    }
    assert.equal(bundle.startGcodePatch?.status, "inserted");
    assert.equal(bundle.startGcodePatch?.preset, PRESET);
    // The bundled preset file itself is never modified.
    assert.equal((await readJson(path.join(tree.bbl, "machine", `${PRESET}.json`))).machine_start_gcode, START_GCODE);
  }
});

test("prepare leaves the stock start G-code alone when the hook is off", async (t) => {
  const tree = await profileTree(t);
  withEnv(t, { BAMBU_PROFILES_ROOT: tree.profiles, BAMBU_SLICER_PROFILE_DIRS: "" });
  const input = path.join(tree.root, "model.stl");
  await fs.writeFile(input, "solid fixture");
  const bundle = await new BambuCliProfilePreparer(path.join(tree.root, "prepared"))
    .prepare(input, "model", "orcaslicer", tree.profiles, PRESET, undefined, {});
  assert.equal((await readJson(bundle.settingsArg.split(";")[0])).machine_start_gcode, START_GCODE);
  assert.equal(bundle.startGcodePatch, undefined);
});

test("sliceSTL fails before running the slicer when the patch cannot be applied", async (t) => {
  const tree = await profileTree(t, START_GCODE.replace(ANCHOR, "M221 R"));
  const file = await snippetFile(t);
  withEnv(t, { BAMBU_PROFILES_ROOT: tree.profiles, BAMBU_SLICER_PROFILE_DIRS: "",
    BAMBU_START_GCODE_INSERT_FILE: file, BAMBU_START_GCODE_INSERT_BEFORE: ANCHOR });
  const input = path.join(tree.root, "model.stl");
  await fs.writeFile(input, "solid fixture");
  // The "slicer" would record that it ran; it must never be reached.
  const ran = path.join(tree.root, "ran.txt");
  const executable = path.join(tree.root, "fake-slicer.mjs");
  await fs.writeFile(executable, `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(ran)}, "ran");\n`);
  const manipulator = new STLManipulator(path.join(tree.root, "out"));
  await assert.rejects(
    manipulator.sliceSTL(input, "orcaslicer", executable, undefined, undefined, PRESET, undefined, {}),
    (error) => error.phase === "preparation" && /Start G-code patch .*appears 0 times.*Refusing to slice/s.test(error.message)
  );
  // A configured patch also refuses the generic (non-Bambu-preset) OrcaSlicer path.
  await assert.rejects(
    manipulator.sliceSTL(input, "orcaslicer", executable, undefined, undefined, undefined, undefined, {}),
    (error) => error.phase === "preparation" && /only slices through a Bambu machine preset/.test(error.message)
  );
  await assert.rejects(fs.access(ran), { code: "ENOENT" });
});

/** print_3mf with stubbed transports; prepare runs for real and then stops the slice. */
async function print3mfServer(t, env, { stopAfterPrepare = true } = {}) {
  const dir = await tempDir(t, "start-gcode-print3mf-");
  const eventsPath = path.join(dir, "events.jsonl");
  const preload = path.join(dir, "boundaries.mjs");
  const href = (file) => JSON.stringify(pathToFileURL(path.join(REPO_ROOT, file)).href);
  await fs.writeFile(preload, `
    import fs from "node:fs";
    import { BambuImplementation } from ${href("dist/printers/bambu.js")};
    import { BambuCliProfilePreparer } from ${href("dist/slicer/bambu-cli.js")};
    const log = (event) => fs.appendFileSync(${JSON.stringify(eventsPath)}, JSON.stringify(event) + "\\n");
    for (const name of ["ftpUpload", "getPrinter", "getSafetyStatus", "getStatus"]) {
      BambuImplementation.prototype[name] = async () => { log({ action: name }); throw new Error("printer boundary reached in test"); };
    }
    const prepare = BambuCliProfilePreparer.prototype.prepare;
    BambuCliProfilePreparer.prototype.prepare = async function (...args) {
      const bundle = await prepare.apply(this, args);
      const machine = JSON.parse(fs.readFileSync(bundle.settingsArg.split(";")[0], "utf8"));
      log({ action: "prepared", start: machine.machine_start_gcode, change: machine.change_filament_gcode, report: bundle.startGcodePatch ?? null });
      if (${JSON.stringify(stopAfterPrepare)}) throw new Error("test stops after profile preparation");
      return bundle;
    };
  `);
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "start-gcode-cwd-"));
  const client = new Client({ name: "start-gcode-test", version: "1" }, { capabilities: { elicitation: { form: {} } } });
  client.setRequestHandler(ElicitRequestSchema, async () => ({ action: "accept", content: { confirmed: true } }));
  // Close the server before removing its working directory (Windows locks it).
  t.after(async () => {
    await client.close();
    await fs.rm(cwd, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: ["--import", pathToFileURL(preload).href, path.join(REPO_ROOT, "dist", "index.js")], cwd,
    env: {
      ...process.env, MCP_TRANSPORT: "stdio", PRINTER_TYPE: "bambu", PRINTER_HOST: "127.0.0.1", API_KEY: "",
      BAMBU_SERIAL: "01PTESTPATCH", BAMBU_TOKEN: "TEST_TOKEN", BAMBU_MODEL: "p1s", NOZZLE_DIAMETER: "", BAMBU_NOZZLE_TYPE: "",
      SLICER_TYPE: "bambustudio", SLICER_PATH: process.execPath, SLICER_PROFILE: "", FILAMENT_PROFILE: "",
      SLICER_FILAMENT_PROFILE: "", BAMBU_SLICER_PROFILE_DIRS: "", BAMBU_TEMPLATE_3MF_PATH: "",
      ...Object.fromEntries(PATCH_KEYS.map((key) => [key, ""])), ...env,
    },
    stderr: "pipe",
  }));
  const events = async () => (await fs.readFile(eventsPath, "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
  return { client, events };
}

async function unslicedProject(t) {
  const file = path.join(await tempDir(t, "start-gcode-project-"), "job.3mf");
  const zip = new JSZip();
  zip.file("3D/3dmodel.model", '<?xml version="1.0"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" type="model"><mesh><vertices/><triangles/></mesh></object></resources><build><item objectid="1"/></build></model>');
  await fs.writeFile(file, await zip.generateAsync({ type: "nodebuffer" }));
  return file;
}

const errorText = (result) => result.content?.map((item) => item.text).join("\n") ?? "";

test("print_3mf auto-slicing applies the same start G-code patch, and fails closed without uploading", async (t) => {
  const tree = await profileTree(t);
  const file = await snippetFile(t);
  const project = await unslicedProject(t);
  const patchEnv = { BAMBU_PROFILES_ROOT: tree.profiles, BAMBU_START_GCODE_INSERT_FILE: file,
    BAMBU_START_GCODE_INSERT_BEFORE: ANCHOR, BAMBU_START_GCODE_INSERT_PRESETS: PRESET };

  await t.test("patched", async (t) => {
    const { client, events } = await print3mfServer(t, patchEnv);
    const result = await client.callTool({ name: "print_3mf", arguments: { three_mf_path: project } });
    assert.equal(result.isError, true);
    assert.match(errorText(result), /Auto-slicing failed; nothing was uploaded or started: (Slicer preparation failed: )?test stops after profile preparation/);
    const log = await events();
    assert.deepEqual(log.map(({ action }) => action), ["prepared"], "nothing may reach the printer");
    const lines = log[0].start.split("\n");
    assert.equal(lines[lines.indexOf(ANCHOR) - 1], ";===== End of Test Wipe");
    assert.equal(log[0].change, CHANGE_FILAMENT);
    assert.equal(log[0].report.status, "inserted");
  });

  await t.test("missing snippet", async (t) => {
    const { client, events } = await print3mfServer(t, { ...patchEnv, BAMBU_START_GCODE_INSERT_FILE: path.join(tree.root, "missing.gcode") });
    const result = await client.callTool({ name: "print_3mf", arguments: { three_mf_path: project } });
    assert.equal(result.isError, true);
    assert.match(errorText(result), /Auto-slicing failed; nothing was uploaded or started: .*Start G-code patch.*cannot read snippet/s);
    assert.deepEqual(await events(), [], "neither preparation output nor any printer boundary may be reached");
  });

  await t.test("hook off", async (t) => {
    const { client, events } = await print3mfServer(t, { BAMBU_PROFILES_ROOT: tree.profiles });
    await client.callTool({ name: "print_3mf", arguments: { three_mf_path: project } });
    const log = await events();
    assert.deepEqual(log.map(({ action }) => action), ["prepared"]);
    assert.equal(log[0].start, START_GCODE);
    assert.equal(log[0].report, null);
  });
});

// ---- Verification of the sliced output ------------------------------------

const WIPE_LINES = [MARKER, "G90", "G1 Z10 F1200", ";===== End of Test Wipe"];
const patchReport = async (t) => applyStartGcodePatch(machine(), PRESET, { file: await snippetFile(t), anchor: ANCHOR }).report;
const startDump = `; machine_start_gcode = ${[...WIPE_LINES, ANCHOR].join("\\n")}`;
/** Plate G-code shaped like OrcaSlicer output: header, start G-code, layers, then the settings dump. */
const plateGcode = (start, { changeFilament = "M620 S[next_extruder]A", tail = [] } = {}) => [
  "; HEADER_BLOCK_START", "; HEADER_BLOCK_END", "; EXECUTABLE_BLOCK_START", ...start,
  "; CHANGE_LAYER", "G1 X10 Y10", ...tail, "; EXECUTABLE_BLOCK_END",
  `; change_filament_gcode = ${changeFilament}`, startDump, "",
].join("\n");
const goodStart = ["G28", ...WIPE_LINES, ANCHOR, "G1 Z10 F1200"];

test("plate verification accepts the snippet directly before the anchor, with slicer progress lines inside", async (t) => {
  const report = await patchReport(t);
  assert.doesNotThrow(() => verifyStartGcodePatchInPlate(plateGcode(goodStart), report));
  const withProgress = ["G28", MARKER, "M73 P1 R9", "G90", "G1 Z10 F1200", "M73 P2 R9", ";===== End of Test Wipe", "M73 P3 R8", ANCHOR];
  assert.doesNotThrow(() => verifyStartGcodePatchInPlate(plateGcode(withProgress).replaceAll("\n", "\r\n"), report));
});

test("plate verification fails closed when the snippet is missing, doubled, misplaced, or in filament-change G-code", async (t) => {
  const report = await patchReport(t);
  const cases = [
    // The settings dump alone (one comment line) never counts as the snippet.
    ["only in the settings dump", plateGcode(["G28", ANCHOR]), /appears 0 times as a G-code line/],
    ["twice", plateGcode(goodStart, { tail: WIPE_LINES }), /appears 2 times as a G-code line/],
    ["after the first layer change", plateGcode(["G28", ANCHOR], { tail: [...WIPE_LINES, ANCHOR] }), /after the first layer change/],
    ["not followed by the anchor", plateGcode(["G28", ...WIPE_LINES, "G4 P0", ANCHOR]), /followed by "G4 P0" instead of the anchor line/],
    ["truncated", plateGcode(["G28", MARKER, "G90", ANCHOR]), /is not where the 4-line snippet should end/],
    ["in change_filament_gcode", plateGcode(goodStart, { changeFilament: `M620 S[next_extruder]A\\n${MARKER}\\nG1 Z10` }), /change_filament_gcode contains the snippet/],
  ];
  for (const [name, gcode, error] of cases) {
    assert.throws(() => verifyStartGcodePatchInPlate(gcode, report), error, name);
  }
});

async function slicedProject(t, plates, projectSettings) {
  const file = path.join(await tempDir(t, "start-gcode-sliced-"), "job_sliced.3mf");
  const zip = new JSZip();
  for (const [name, gcode] of Object.entries(plates)) zip.file(name, gcode);
  if (projectSettings) zip.file("Metadata/project_settings.config", JSON.stringify(projectSettings));
  await fs.writeFile(file, await zip.generateAsync({ type: "nodebuffer" }));
  return file;
}

test("every sliced plate and the project settings are checked", async (t) => {
  const report = await patchReport(t);
  const good = plateGcode(goodStart);
  assert.deepEqual(await verifyStartGcodePatchInSlicedProject(await slicedProject(t, {
    "Metadata/plate_1.gcode": good, "Metadata/plate_2.gcode": good, "Metadata/plate_3.gcode": "", "Metadata/plate_1.gcode.md5": "x",
  }, { change_filament_gcode: "M620 S[next_extruder]A" }), report), ["Metadata/plate_1.gcode", "Metadata/plate_2.gcode"]);
  await assert.rejects(verifyStartGcodePatchInSlicedProject(await slicedProject(t, {
    "Metadata/plate_1.gcode": good, "Metadata/plate_2.gcode": plateGcode(["G28", ANCHOR]),
  }), report), /not correctly present in the sliced output Metadata\/plate_2\.gcode: .*appears 0 times.*Refusing to use this slice/s);
  await assert.rejects(verifyStartGcodePatchInSlicedProject(await slicedProject(t, { "Metadata/plate_1.gcode": good },
    { change_filament_gcode: `M620 S[next_extruder]A\n${MARKER}\nG1 Z10` }), report),
    /Metadata\/project_settings\.config: change_filament_gcode contains the snippet/);
  await assert.rejects(verifyStartGcodePatchInSlicedProject(await slicedProject(t, { "Metadata/plate_1.gcode.md5": "x" }), report),
    /no sliced plate G-code to check/);
});

/** A fake Bambu CLI (POSIX shebang script) that copies a prepared sliced project. */
async function fakeSlicer(t, outputFixture) {
  const dir = await tempDir(t, "start-gcode-fake-cli-");
  const executable = path.join(dir, "fake-bambu-cli");
  const ran = path.join(dir, "ran.json");
  await fs.writeFile(executable, `#!${process.execPath}
const fs = require("fs"); const path = require("path");
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(ran)}, JSON.stringify(args));
fs.copyFileSync(${JSON.stringify(outputFixture)}, path.join(args[args.indexOf("--outputdir") + 1], args[args.indexOf("--export-3mf") + 1]));
`, { mode: 0o755 });
  return { executable, ran };
}

const posixOnly = { skip: process.platform === "win32" ? "the fake slicer is a POSIX shebang script" : false };

test("sliceSTL verifies the slicer's output and never returns a slice without the applied patch", posixOnly, async (t) => {
  const tree = await profileTree(t);
  const file = await snippetFile(t);
  withEnv(t, { BAMBU_PROFILES_ROOT: tree.profiles, BAMBU_SLICER_PROFILE_DIRS: "",
    BAMBU_START_GCODE_INSERT_FILE: file, BAMBU_START_GCODE_INSERT_BEFORE: ANCHOR });
  const input = path.join(tree.root, "model.stl");
  await fs.writeFile(input, "solid fixture");
  const manipulator = new STLManipulator(path.join(tree.root, "out"));
  const slice = (executable) => manipulator.sliceSTL(input, "bambustudio", executable, undefined, undefined, PRESET, undefined, {});

  const good = await fakeSlicer(t, await slicedProject(t, { "Metadata/plate_1.gcode": plateGcode(goodStart) }));
  const output = await slice(good.executable);
  assert.equal(manipulator.takeStartGcodePatchReport(output)?.status, "inserted");

  const stock = await fakeSlicer(t, await slicedProject(t, { "Metadata/plate_1.gcode": plateGcode(["G28", ANCHOR]) }));
  await assert.rejects(slice(stock.executable),
    (error) => error.phase === "output" && /not correctly present in the sliced output Metadata\/plate_1\.gcode/.test(error.message));
  await fs.access(stock.ran); // the slicer ran; its output was rejected afterwards
});

test("print_3mf auto-slicing rejects slicer output without the applied patch before any printer contact", posixOnly, async (t) => {
  const tree = await profileTree(t);
  const file = await snippetFile(t);
  const project = await unslicedProject(t);
  const patchEnv = { BAMBU_PROFILES_ROOT: tree.profiles, BAMBU_START_GCODE_INSERT_FILE: file,
    BAMBU_START_GCODE_INSERT_BEFORE: ANCHOR, BAMBU_START_GCODE_INSERT_PRESETS: PRESET };
  const stock = await fakeSlicer(t, await slicedProject(t, { "Metadata/plate_1.gcode": plateGcode(["G28", ANCHOR]) }));
  const { client, events } = await print3mfServer(t, { ...patchEnv, SLICER_PATH: stock.executable }, { stopAfterPrepare: false });
  const result = await client.callTool({ name: "print_3mf", arguments: { three_mf_path: project } });
  assert.equal(result.isError, true);
  assert.match(errorText(result), /Auto-slicing failed; nothing was uploaded or started: .*Start G-code patch .*not correctly present in the sliced output Metadata\/plate_1\.gcode/s);
  assert.deepEqual((await events()).map(({ action }) => action), ["prepared"], "no printer boundary may be reached");

  // With a correct slice, verification passes and the job moves on to the (stubbed) printer checks.
  const good = await fakeSlicer(t, await slicedProject(t, { "Metadata/plate_1.gcode": plateGcode(goodStart) }));
  const passed = await print3mfServer(t, { ...patchEnv, SLICER_PATH: good.executable }, { stopAfterPrepare: false });
  const next = await passed.client.callTool({ name: "print_3mf", arguments: { three_mf_path: project } });
  assert.doesNotMatch(errorText(next), /Start G-code patch|Auto-slicing failed/);
  assert.ok((await passed.events()).some(({ action }) => action === "prepared"));
});
