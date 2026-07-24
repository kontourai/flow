import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const FLOW_RUN_DEFINITION_FILE = "definition.json";
export const FLOW_RUN_STATE_FILE = "state.json";
export const FLOW_RUN_REPORT_JSON_FILE = "report.json";
export const FLOW_RUN_REPORT_MARKDOWN_FILE = "report.md";
export const FLOW_RUN_RECOVERY_FENCE_FILE = "recovery-fence.json";
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

/** The canonical root for generated Flow runtime state. */
export function flowRuntimeRoot(cwd = process.cwd()) {
  return path.join(cwd, ".kontourai", "flow");
}

export function flowConfigPath(cwd = process.cwd()) {
  return path.join(flowRoot(cwd), "config.json");
}

export function assertSafeRunId(runId: string): string {
  if (
    !runId ||
    path.isAbsolute(runId) ||
    runId.includes("/") ||
    runId.includes("\\") ||
    runId.includes("\0") ||
    runId.split(/[\\/]/).some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`invalid run id: ${runId}`);
  }
  return runId;
}

export function runDir(runId, cwd = process.cwd()) {
  return path.join(flowRuntimeRoot(cwd), "runs", assertSafeRunId(runId));
}

function isMissingPathError(error: unknown) {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === "ENOENT";
}

export async function assertSafeWorkingDirectory(cwd: string) {
  const resolved = path.resolve(cwd);
  let entry;
  try {
    entry = await lstat(resolved);
  } catch (error) {
    const wrapped = new Error(`flow.run_location.unsafe_working_directory: cannot inspect ${resolved}: ${error instanceof Error ? error.message : String(error)}`);
    (wrapped as Error & { code?: string }).code = "flow.run_location.unsafe_working_directory";
    throw wrapped;
  }
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    const error = new Error(`flow.run_location.unsafe_working_directory: ${resolved} must be a real directory`);
    (error as Error & { code?: string }).code = "flow.run_location.unsafe_working_directory";
    throw error;
  }
  return resolved;
}

function safeRelativeParts(relativePath: string) {
  if (
    !relativePath ||
    path.isAbsolute(relativePath) ||
    relativePath.includes("\0") ||
    relativePath.split(/[\\/]/).some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`flow.run_location.invalid_artifact_path: ${relativePath}`);
  }
  return relativePath.split(/[\\/]/);
}

/** Create an owned directory tree without following links below the trusted base. */
export async function ensureDirectoryPathWithoutSymlinks(base: string, relativePath: string) {
  let cursor = await assertSafeWorkingDirectory(base);
  for (const part of safeRelativeParts(relativePath)) {
    cursor = path.join(cursor, part);
    try {
      await mkdir(cursor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
    }
    const entry = await lstat(cursor);
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new Error(`flow.run_location.unsafe_directory: ${cursor} must be a real directory`);
    }
  }
  return cursor;
}

/** Reject links and traversal before writing a file beneath a resolved run. */
export async function assertSafeRunArtifactWritePath(dir: string, relativePath: string) {
  const root = path.resolve(dir);
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`flow.run_location.symlink_not_allowed: run directory ${root} must be a real directory`);
  }

  let cursor = root;
  const parts = safeRelativeParts(relativePath);
  for (const [index, part] of parts.entries()) {
    cursor = path.join(cursor, part);
    try {
      const entry = await lstat(cursor);
      if (entry.isSymbolicLink()) throw new Error(`flow.run_location.symlink_not_allowed: ${cursor}`);
      if (index < parts.length - 1 && !entry.isDirectory()) {
        throw new Error(`flow.run_location.invalid_artifact_path: ${cursor} is not a directory`);
      }
      if (index === parts.length - 1 && !entry.isFile()) {
        throw new Error(`flow.run_location.invalid_artifact_path: ${cursor} is not a file`);
      }
    } catch (error) {
      if (isMissingPathError(error)) break;
      throw error;
    }
  }
  return path.join(root, ...parts);
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
