import { existsSync } from "node:fs";
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

// Emitted trust bundles (recursive trust): the run's own outcome as Hachure
// trust.bundle artifacts the Surface trust panel can pick up.
export const FLOW_RUN_TRUST_DIR = "trust";
export const FLOW_RUN_TRUST_RUN_BUNDLE_FILE = "run.json";
export const FLOW_RUN_TRUST_RUN_BUNDLE_PATH = `${FLOW_RUN_TRUST_DIR}/${FLOW_RUN_TRUST_RUN_BUNDLE_FILE}`;

export function flowRunTrustGateBundleFile(gateId: string) {
  return `gate.${gateId}.json`;
}

export function flowRunTrustGateBundlePath(gateId: string) {
  return `${FLOW_RUN_TRUST_DIR}/${flowRunTrustGateBundleFile(gateId)}`;
}

export const FLOW_RUN_LAYOUT = Object.freeze({
  definition: FLOW_RUN_DEFINITION_FILE,
  state: FLOW_RUN_STATE_FILE,
  evidenceDirectory: FLOW_RUN_EVIDENCE_DIR,
  evidenceManifest: FLOW_RUN_EVIDENCE_MANIFEST_PATH,
  reportJson: FLOW_RUN_REPORT_JSON_FILE,
  reportMarkdown: FLOW_RUN_REPORT_MARKDOWN_FILE,
  trustDirectory: FLOW_RUN_TRUST_DIR,
  trustRunBundle: FLOW_RUN_TRUST_RUN_BUNDLE_PATH
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
  // Compiled location is dist/runtime/flow-files.js; the package root is the
  // nearest ancestor with package.json so packaged assets resolve regardless
  // of how deep this module sits under dist/.
  let dir = path.dirname(fileURLToPath(import.meta.url));
  while (!existsSync(path.join(dir, "package.json"))) {
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error("unable to locate the @kontourai/flow package root");
    dir = parent;
  }
  return dir;
}

export function examplePath(file) {
  return path.join(moduleRoot(), "examples", file);
}
