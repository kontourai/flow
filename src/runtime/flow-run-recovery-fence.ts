import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, rename, rm } from "node:fs/promises";
import path from "node:path";

import { isNonEmptyString } from "../shared/flow-utils.js";
import { parseRfc3339Timestamp } from "../shared/rfc3339.js";
import {
  FLOW_RUN_RECOVERY_FENCE_FILE,
  assertSafeRunId,
  assertSafeWorkingDirectory,
  runDir
} from "./flow-files.js";

export const FLOW_RUN_RECOVERY_FENCE_PROTOCOL = "flow.run-recovery-fence.v1";

export type FlowRunRecoveryFenceStatus = "active" | "open";

export interface FlowRunRecoveryFenceWrite {
  protocol: typeof FLOW_RUN_RECOVERY_FENCE_PROTOCOL;
  run_id: string;
  recovery_id: string;
  status: "active";
  updated_at: string;
}

export interface FlowRunRecoveryFence {
  protocol: typeof FLOW_RUN_RECOVERY_FENCE_PROTOCOL;
  run_id: string;
  recovery_id: string;
  status: FlowRunRecoveryFenceStatus;
  updated_at: string;
  /** Flow-generated identity; callers cannot reuse or choose it. */
  generation: string;
  /** Active generation finalized by this open successor. Absent only on legacy open records. */
  previous_generation?: string;
}

export interface FlowRunRecoveryFenceFinalizeRequest {
  recovery_id: string;
  expected_generation: string;
  updated_at: string;
}

export interface FlowRunRecoveryDirectoryIdentity {
  device: string;
  inode: string;
}

export type FlowRunRecoveryFenceSnapshot =
  | {
      status: "absent";
      /** Missing only when the fixed run directory itself does not exist. */
      directory?: FlowRunRecoveryDirectoryIdentity;
    }
  | {
      status: FlowRunRecoveryFenceStatus;
      fence: FlowRunRecoveryFence;
      fingerprint: string;
      directory: FlowRunRecoveryDirectoryIdentity;
    };

export interface RunRecoveryFenceWriteHooks {
  afterTempWrite?: () => Promise<void> | void;
  afterTempFsync?: () => Promise<void> | void;
  afterRename?: () => Promise<void> | void;
  afterParentFsync?: () => Promise<void> | void;
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_RECOVERY_FENCE_BYTES = 64 * 1024;

function recoveryFenceError(code: string, message: string): Error {
  const error = new Error(`${code}: ${message}`);
  (error as Error & { code?: string }).code = code;
  return error;
}

function isMissingPathError(error: unknown) {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

function validateFenceFields(
  value: unknown,
  runId: string,
  options: { persisted: boolean; writeStatus?: "active" | "open" }
): FlowRunRecoveryFence {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw recoveryFenceError("flow.run_recovery.malformed", `recovery fence for run "${runId}" must be an object`);
  }
  const record = value as Record<string, unknown>;
  if (record.protocol !== FLOW_RUN_RECOVERY_FENCE_PROTOCOL) {
    throw recoveryFenceError("flow.run_recovery.unknown", `recovery fence for run "${runId}" uses an unknown protocol`);
  }
  if (record.status !== "active" && record.status !== "open") {
    throw recoveryFenceError("flow.run_recovery.unknown", `recovery fence for run "${runId}" has unknown status "${String(record.status)}"`);
  }
  if (!options.persisted && options.writeStatus && record.status !== options.writeStatus) {
    throw recoveryFenceError(
      "flow.run_recovery.open_requires_finalize",
      `run "${runId}" may publish an open recovery fence only through finalizeRunRecoveryFence`
    );
  }
  const hasPreviousGeneration = record.status === "open" && Object.hasOwn(record, "previous_generation");
  const expectedKeys = [
    ...(options.persisted ? ["generation"] : []),
    ...(hasPreviousGeneration ? ["previous_generation"] : []),
    "protocol",
    "recovery_id",
    "run_id",
    "status",
    "updated_at"
  ];
  const actualKeys = Object.keys(record).sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw recoveryFenceError("flow.run_recovery.malformed", `recovery fence for run "${runId}" has an invalid shape`);
  }
  if (record.run_id !== runId) {
    throw recoveryFenceError("flow.run_recovery.malformed", `recovery fence run_id must be "${runId}"`);
  }
  if (!isNonEmptyString(record.recovery_id)) {
    throw recoveryFenceError("flow.run_recovery.malformed", `recovery fence for run "${runId}" requires recovery_id`);
  }
  if (
    options.persisted &&
    (!isNonEmptyString(record.generation) || !UUID_V4.test(String(record.generation)))
  ) {
    throw recoveryFenceError("flow.run_recovery.malformed", `recovery fence for run "${runId}" requires a Flow-generated UUID v4 generation`);
  }
  if (
    record.status === "open" &&
    ((!options.persisted && !hasPreviousGeneration) ||
      (hasPreviousGeneration && (!isNonEmptyString(record.previous_generation) || !UUID_V4.test(String(record.previous_generation)))))
  ) {
    throw recoveryFenceError("flow.run_recovery.malformed", `open recovery fence for run "${runId}" requires a Flow-generated predecessor generation`);
  }
  if (
    !isNonEmptyString(record.updated_at) ||
    parseRfc3339Timestamp(record.updated_at) === null
  ) {
    throw recoveryFenceError("flow.run_recovery.malformed", `recovery fence for run "${runId}" requires a date-time updated_at`);
  }
  return record as unknown as FlowRunRecoveryFence;
}

function directoryIdentity(entry: { dev: number | bigint; ino: number | bigint }): FlowRunRecoveryDirectoryIdentity {
  return {
    device: String(entry.dev),
    inode: String(entry.ino)
  };
}

function sameDirectoryIdentity(
  left: FlowRunRecoveryDirectoryIdentity,
  right: FlowRunRecoveryDirectoryIdentity
) {
  return left.device === right.device && left.inode === right.inode;
}

function assertSameDirectoryIdentity(
  runId: string,
  expected: FlowRunRecoveryDirectoryIdentity,
  actual: FlowRunRecoveryDirectoryIdentity,
  stage: string
) {
  if (!sameDirectoryIdentity(expected, actual)) {
    throw recoveryFenceError(
      "flow.run_recovery.changed",
      `fixed run directory for "${runId}" changed ${stage}`
    );
  }
}

async function assertCanonicalRunDirectory(
  runId: string,
  cwd: string,
  options: { allowMissing?: boolean } = {}
) {
  const base = await assertSafeWorkingDirectory(cwd);
  const target = runDir(runId, cwd);
  const relative = path.relative(base, target);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw recoveryFenceError("flow.run_recovery.path_invalid", `run "${runId}" is outside working directory ${base}`);
  }
  let cursor = base;
  for (const part of relative.split(path.sep)) {
    cursor = path.join(cursor, part);
    let entry;
    try {
      entry = await lstat(cursor, { bigint: true });
    } catch (error) {
      if (isMissingPathError(error)) {
        if (options.allowMissing) return null;
        throw recoveryFenceError("flow.run_recovery.not_found", `run "${runId}" was not found at ${target}`);
      }
      throw error;
    }
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw recoveryFenceError("flow.run_recovery.path_invalid", `${cursor} must be a real directory`);
    }
  }
  const finalEntry = await lstat(target, { bigint: true });
  return { dir: target, identity: directoryIdentity(finalEntry) };
}

export function flowRunRecoveryFencePath(runId: string, cwd = process.cwd()) {
  return path.join(runDir(assertSafeRunId(runId), path.resolve(cwd)), FLOW_RUN_RECOVERY_FENCE_FILE);
}

export async function inspectRunRecoveryFence(
  runId: string,
  cwd = process.cwd()
): Promise<FlowRunRecoveryFenceSnapshot> {
  assertSafeRunId(runId);
  const resolvedCwd = path.resolve(cwd);
  const resolved = await assertCanonicalRunDirectory(runId, resolvedCwd, { allowMissing: true });
  if (!resolved) return { status: "absent" };
  const absentSnapshot = async (): Promise<FlowRunRecoveryFenceSnapshot> => {
    const after = await assertCanonicalRunDirectory(runId, resolvedCwd);
    if (!sameDirectoryIdentity(resolved.identity, after.identity)) {
      throw recoveryFenceError(
        "flow.run_recovery.changed",
        `fixed run directory for "${runId}" changed while fence absence was inspected`
      );
    }
    return { status: "absent", directory: after.identity };
  };
  const file = path.join(resolved.dir, FLOW_RUN_RECOVERY_FENCE_FILE);
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isMissingPathError(error)) return absentSnapshot();
    if ((error as NodeJS.ErrnoException)?.code === "ELOOP") {
      throw recoveryFenceError("flow.run_recovery.malformed", `recovery fence for run "${runId}" must not be a symbolic link`);
    }
    throw error;
  }
  try {
    const entry = await handle.stat();
    if (!entry.isFile()) {
      throw recoveryFenceError("flow.run_recovery.malformed", `recovery fence for run "${runId}" must be a regular file`);
    }
    if ((entry.mode & 0o022) !== 0) {
      throw recoveryFenceError("flow.run_recovery.malformed", `recovery fence for run "${runId}" must not be group- or world-writable`);
    }
    if (entry.size > MAX_RECOVERY_FENCE_BYTES) {
      throw recoveryFenceError("flow.run_recovery.malformed", `recovery fence for run "${runId}" exceeds ${MAX_RECOVERY_FENCE_BYTES} bytes`);
    }
    const bounded = Buffer.allocUnsafe(MAX_RECOVERY_FENCE_BYTES + 1);
    let offset = 0;
    while (offset < bounded.length) {
      const { bytesRead } = await handle.read(
        bounded,
        offset,
        bounded.length - offset,
        offset
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_RECOVERY_FENCE_BYTES) {
      throw recoveryFenceError("flow.run_recovery.malformed", `recovery fence for run "${runId}" exceeds ${MAX_RECOVERY_FENCE_BYTES} bytes`);
    }
    const bytes = bounded.subarray(0, offset);
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw recoveryFenceError("flow.run_recovery.malformed", `recovery fence for run "${runId}" is not valid JSON`);
    }
    const fence = validateFenceFields(parsed, runId, { persisted: true }) as FlowRunRecoveryFence;
    const after = await assertCanonicalRunDirectory(runId, resolvedCwd);
    if (!sameDirectoryIdentity(resolved.identity, after.identity)) {
      throw recoveryFenceError(
        "flow.run_recovery.changed",
        `fixed run directory for "${runId}" changed while its recovery fence was inspected`
      );
    }
    return {
      status: fence.status,
      fence,
      fingerprint: createHash("sha256").update(bytes).digest("hex"),
      directory: after.identity
    };
  } finally {
    await handle.close();
  }
}

export async function writeRunRecoveryFence(
  runId: string,
  fence: FlowRunRecoveryFenceWrite,
  cwd = process.cwd(),
  hooks: RunRecoveryFenceWriteHooks = {}
): Promise<FlowRunRecoveryFenceSnapshot> {
  return publishRunRecoveryFence(runId, fence, cwd, hooks, "active");
}

/** @internal Open publication is called only while flow-run-store holds the native ticket. */
export async function publishOpenRunRecoveryFence(
  runId: string,
  fence: Omit<FlowRunRecoveryFence, "generation"> & { status: "open"; previous_generation: string },
  cwd = process.cwd(),
  hooks: RunRecoveryFenceWriteHooks = {}
): Promise<FlowRunRecoveryFenceSnapshot> {
  return publishRunRecoveryFence(runId, fence, cwd, hooks, "open");
}

async function publishRunRecoveryFence(
  runId: string,
  fence: Omit<FlowRunRecoveryFence, "generation">,
  cwd: string,
  hooks: RunRecoveryFenceWriteHooks,
  writeStatus: "active" | "open"
): Promise<FlowRunRecoveryFenceSnapshot> {
  assertSafeRunId(runId);
  const resolvedCwd = path.resolve(cwd);
  const validated = validateFenceFields(fence, runId, { persisted: false, writeStatus });
  const resolved = await assertCanonicalRunDirectory(runId, resolvedCwd);
  const record: FlowRunRecoveryFence = {
    ...validated,
    generation: randomUUID()
  };
  const target = path.join(resolved.dir, FLOW_RUN_RECOVERY_FENCE_FILE);
  const temporary = path.join(resolved.dir, `.${FLOW_RUN_RECOVERY_FENCE_FILE}.${randomUUID()}.tmp`);
  let temporaryHandle;
  try {
    temporaryHandle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    );
    await temporaryHandle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
    await hooks.afterTempWrite?.();
    await temporaryHandle.sync();
    await hooks.afterTempFsync?.();
    await temporaryHandle.close();
    temporaryHandle = undefined;
    const beforeRename = await assertCanonicalRunDirectory(runId, resolvedCwd);
    assertSameDirectoryIdentity(
      runId,
      resolved.identity,
      beforeRename.identity,
      "before recovery fence rename"
    );
    await rename(temporary, target);
    await hooks.afterRename?.();
    const parentHandle = await open(resolved.dir, constants.O_RDONLY);
    try {
      const parentStat = await parentHandle.stat({ bigint: true });
      assertSameDirectoryIdentity(
        runId,
        resolved.identity,
        directoryIdentity(parentStat),
        "before parent-directory fsync"
      );
      await parentHandle.sync();
    } finally {
      await parentHandle.close();
    }
    const afterParentFsync = await assertCanonicalRunDirectory(runId, resolvedCwd);
    assertSameDirectoryIdentity(
      runId,
      resolved.identity,
      afterParentFsync.identity,
      "after parent-directory fsync"
    );
    await hooks.afterParentFsync?.();
  } finally {
    await temporaryHandle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
  return inspectRunRecoveryFence(runId, resolvedCwd);
}

export async function assertRunRecoveryFenceOpen(
  runId: string,
  cwd = process.cwd()
): Promise<FlowRunRecoveryFenceSnapshot> {
  const snapshot = await inspectRunRecoveryFence(runId, cwd);
  if (snapshot.status === "active") {
    throw recoveryFenceError(
      "flow.run_recovery.active",
      `run "${runId}" is fenced while recovery "${snapshot.fence.recovery_id}" is active`
    );
  }
  return snapshot;
}

function sameSnapshot(
  before: FlowRunRecoveryFenceSnapshot,
  after: FlowRunRecoveryFenceSnapshot
) {
  if (before.status === "absent" || after.status === "absent") {
    if (before.status !== "absent" || after.status !== "absent") return false;
    if (!before.directory || !after.directory) return !before.directory && !after.directory;
    return sameDirectoryIdentity(before.directory, after.directory);
  }
  return before.fingerprint === after.fingerprint
    && before.fence.generation === after.fence.generation
    && sameDirectoryIdentity(before.directory, after.directory);
}

export async function withRunRecoveryFenceRead<T>(
  runId: string,
  cwd: string,
  operation: () => Promise<T>
): Promise<T> {
  let before: FlowRunRecoveryFenceSnapshot;
  let pathInvalidBefore = false;
  try {
    before = await assertRunRecoveryFenceOpen(runId, cwd);
  } catch (error) {
    // Let the owning supported API retain its more specific canonical-location
    // diagnostic. If that operation somehow succeeds, the post-read fence
    // inspection below still fails closed on the unsafe path.
    if ((error as Error & { code?: string }).code !== "flow.run_recovery.path_invalid") {
      throw error;
    }
    pathInvalidBefore = true;
    before = { status: "absent" };
  }
  let result: T | undefined;
  let operationError: unknown;
  let operationFailed = false;
  try {
    result = await operation();
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }
  let after: FlowRunRecoveryFenceSnapshot;
  try {
    after = await assertRunRecoveryFenceOpen(runId, cwd);
  } catch (error) {
    if (
      pathInvalidBefore &&
      operationFailed &&
      (error as Error & { code?: string }).code === "flow.run_recovery.path_invalid"
    ) {
      throw operationError;
    }
    throw error;
  }
  if (!sameSnapshot(before, after)) {
    throw recoveryFenceError(
      "flow.run_recovery.changed",
      `recovery fence for run "${runId}" changed while the supported read was in progress`
    );
  }
  if (operationFailed) throw operationError;
  return result as T;
}
