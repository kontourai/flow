import { randomUUID } from "node:crypto";
import { constants as fsConstants, existsSync } from "node:fs";
import { lstat, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
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
    if (isMissingPathError(error)) {
      const missing = new Error(
        `flow.run_location.working_directory_not_found: working directory ${resolved} does not exist; create it first or pass an existing directory with --cwd`
      );
      (missing as Error & { code?: string }).code = "flow.run_location.working_directory_not_found";
      throw missing;
    }
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

/** Default mode for a freshly published run artifact when no prior file exists. */
const RUN_ARTIFACT_DEFAULT_MODE = 0o600;

async function existingFileMode(file: string): Promise<number | undefined> {
  try {
    const entry = await lstat(file);
    if (entry.isSymbolicLink() || !entry.isFile()) return undefined;
    return entry.mode & 0o7777;
  } catch (error) {
    if (isMissingPathError(error)) return undefined;
    throw error;
  }
}

/**
 * Stage one run artifact for an atomic publication.
 *
 * `writeFile` publishes by truncate-then-write, so any concurrent reader — a
 * `flow status`, the console server's watcher, a downstream consumer — can
 * observe an empty or half-written `state.json`, and a crash mid-write leaves
 * one behind permanently. Every run artifact is therefore written to a sibling
 * temp file, fsynced, and moved into place with `rename(2)`, which is atomic
 * for a reader on POSIX. The prior mode is preserved so publishing atomically
 * does not silently narrow who can read a run.
 */
export async function stageRunArtifact(target: string, contents: string) {
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${randomUUID()}.tmp`
  );
  const mode = await existingFileMode(target);
  let handle;
  try {
    handle = await open(
      temporary,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      RUN_ARTIFACT_DEFAULT_MODE
    );
    await handle.writeFile(contents, "utf8");
    if (mode !== undefined && mode !== RUN_ARTIFACT_DEFAULT_MODE) await handle.chmod(mode);
    // Durability: the temp file's bytes must reach the disk before the rename
    // publishes it, otherwise a crash can expose an empty file under the
    // canonical name.
    await handle.sync();
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  await handle.close();
  return {
    target,
    temporary,
    commit: () => rename(temporary, target),
    discard: () => rm(temporary, { force: true }).catch(() => undefined)
  };
}

/** fsync a directory so a completed rename survives a crash. */
export async function syncDirectory(dir: string) {
  const handle = await open(dir, fsConstants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Publish a set of run artifacts so no reader ever observes a partial file.
 *
 * Entries are staged in order, then committed in order: callers put derived
 * projections first and the canonical record (`state.json`) last, so a failure
 * between renames leaves the canonical record on its previous, coherent value.
 */
export async function publishRunArtifacts(
  dir: string,
  entries: Array<{ path: string; contents: string }>
) {
  const staged: Array<Awaited<ReturnType<typeof stageRunArtifact>>> = [];
  try {
    for (const entry of entries) staged.push(await stageRunArtifact(entry.path, entry.contents));
    for (const entry of staged) await entry.commit();
  } catch (error) {
    await Promise.all(staged.map((entry) => entry.discard()));
    throw error;
  }
  await syncDirectory(dir);
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
