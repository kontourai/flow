import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const FLOW_RUN_DEFINITION_FILE = "definition.json";
export const FLOW_RUN_STATE_FILE = "state.json";
export const FLOW_RUN_REPORT_JSON_FILE = "report.json";
export const FLOW_RUN_REPORT_MARKDOWN_FILE = "report.md";
export const FLOW_RUN_EVIDENCE_DIR = "evidence";
export const FLOW_RUN_EVIDENCE_MANIFEST_FILE = "manifest.json";
export const FLOW_RUN_EVIDENCE_MANIFEST_PATH = `${FLOW_RUN_EVIDENCE_DIR}/${FLOW_RUN_EVIDENCE_MANIFEST_FILE}`;

export const FLOW_RUN_LAYOUT = Object.freeze({
  definition: FLOW_RUN_DEFINITION_FILE,
  state: FLOW_RUN_STATE_FILE,
  evidenceDirectory: FLOW_RUN_EVIDENCE_DIR,
  evidenceManifest: FLOW_RUN_EVIDENCE_MANIFEST_PATH,
  reportJson: FLOW_RUN_REPORT_JSON_FILE,
  reportMarkdown: FLOW_RUN_REPORT_MARKDOWN_FILE
});

export function flowRoot(cwd = process.cwd()) {
  return path.join(cwd, ".flow");
}

export function flowConfigPath(cwd = process.cwd()) {
  return path.join(flowRoot(cwd), "config.json");
}

export function assertSafeRunId(runId: string): string {
  if (
    !runId ||
    path.isAbsolute(runId) ||
    runId.includes("\0") ||
    runId.split(/[\\/]/).some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`invalid run id: ${runId}`);
  }
  return runId;
}

export function runDir(runId, cwd = process.cwd()) {
  return path.join(flowRoot(cwd), "runs", assertSafeRunId(runId));
}

export async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

export async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function moduleRoot() {
  return path.dirname(path.dirname(fileURLToPath(import.meta.url)));
}

export function examplePath(file) {
  return path.join(moduleRoot(), "examples", file);
}
