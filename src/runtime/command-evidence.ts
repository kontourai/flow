import { createHash } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { mkdtemp, open, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { spawn } from "node:child_process";

import { FLOW_SCHEMA_VERSION } from "../contracts/flow-types.js";

export const COMMAND_CAPTURE_DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
export const COMMAND_CAPTURE_OUTPUT_LIMIT_BYTES = 1024 * 1024;
export const COMMAND_CAPTURE_KILL_GRACE_MS = 5000;
const COMMAND_CAPTURE_KILL_SETTLE_MS = 50;

type CapturedOutput = {
  content: string;
  byte_count: number;
  captured_byte_count: number;
  truncated: boolean;
};

async function readCapturedOutput(file: string, byteCount: number, limit: number): Promise<CapturedOutput> {
  const buffer = Buffer.alloc(limit);
  let bytesRead = 0;
  if (limit > 0) {
    const handle = await open(file, "r");
    try {
      ({ bytesRead } = await handle.read(buffer, 0, limit, 0));
    } finally {
      await handle.close();
    }
  }
  const content = buffer.subarray(0, bytesRead).toString("utf8");
  return {
    content,
    byte_count: byteCount,
    captured_byte_count: bytesRead,
    truncated: byteCount > bytesRead
  };
}

function outputBudgets(stdoutBytes: number, stderrBytes: number) {
  const half = Math.floor(COMMAND_CAPTURE_OUTPUT_LIMIT_BYTES / 2);
  let stdout = Math.min(stdoutBytes, half);
  const stderr = Math.min(stderrBytes, COMMAND_CAPTURE_OUTPUT_LIMIT_BYTES - stdout);
  stdout = Math.min(stdoutBytes, COMMAND_CAPTURE_OUTPUT_LIMIT_BYTES - stderr);
  return { stdout, stderr };
}

function signalProcessGroup(pid: number | undefined, signal: NodeJS.Signals) {
  if (pid === undefined) return false;
  try {
    process.kill(process.platform === "win32" ? pid : -pid, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

function processGroupExists(pid: number | undefined) {
  if (pid === undefined) return false;
  try {
    process.kill(process.platform === "win32" ? pid : -pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function runCommand(command: string[], options: { cwd: string; timeoutMs: number; stdoutFd: number; stderrFd: number }) {
  return new Promise<{ status: number | null; signal: NodeJS.Signals | null; error?: Error; timedOut: boolean }>((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), {
      cwd: options.cwd,
      stdio: ["ignore", options.stdoutFd, options.stderrFd],
      detached: true,
      windowsHide: true
    });
    let timedOut = false;
    let childClosed = false;
    let status: number | null = null;
    let signal: NodeJS.Signals | null = null;
    let spawnError: Error | undefined;
    let escalationComplete = false;
    let settled = false;
    let escalationTimer: NodeJS.Timeout | undefined;
    let settleTimer: NodeJS.Timeout | undefined;

    const clearTerminationTimers = () => {
      if (escalationTimer) clearTimeout(escalationTimer);
      if (settleTimer) clearTimeout(settleTimer);
    };
    const finish = () => {
      if (settled || !childClosed) return;
      if (timedOut && !escalationComplete && processGroupExists(child.pid)) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTerminationTimers();
      resolve({ status: spawnError ? null : status, signal, error: spawnError, timedOut });
    };
    const failTermination = (error: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTerminationTimers();
      reject(error);
    };
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      try {
        signalProcessGroup(child.pid, "SIGTERM");
      } catch (error) {
        failTermination(error);
        return;
      }
      escalationTimer = setTimeout(() => {
        try {
          signalProcessGroup(child.pid, "SIGKILL");
        } catch (error) {
          failTermination(error);
          return;
        }
        settleTimer = setTimeout(() => {
          escalationComplete = true;
          finish();
        }, COMMAND_CAPTURE_KILL_SETTLE_MS);
      }, COMMAND_CAPTURE_KILL_GRACE_MS);
      finish();
    }, options.timeoutMs);

    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", (code, closeSignal) => {
      childClosed = true;
      status = code;
      signal = closeSignal;
      finish();
    });
  });
}

export async function captureCommand(command: string[], options: { cwd: string; timeoutMs: number }) {
  const captureDir = await mkdtemp(path.join(tmpdir(), "flow-command-capture-"));
  try {
    const stdoutPath = path.join(captureDir, "stdout");
    const stderrPath = path.join(captureDir, "stderr");
    const receiptPath = path.join(captureDir, "command-evidence.json");
    const stdoutFd = openSync(stdoutPath, "wx");
    let stderrFd: number | undefined;
    const startedAt = new Date().toISOString();
    const started = performance.now();
    let result;
    try {
      stderrFd = openSync(stderrPath, "wx");
      result = await runCommand(command, {
        cwd: options.cwd,
        timeoutMs: options.timeoutMs,
        stdoutFd,
        stderrFd
      });
    } finally {
      closeSync(stdoutFd);
      if (stderrFd !== undefined) closeSync(stderrFd);
    }
    const durationMs = performance.now() - started;
    const [stdoutStat, stderrStat] = await Promise.all([stat(stdoutPath), stat(stderrPath)]);
    const budgets = outputBudgets(stdoutStat.size, stderrStat.size);
    const [stdout, stderr] = await Promise.all([
      readCapturedOutput(stdoutPath, stdoutStat.size, budgets.stdout),
      readCapturedOutput(stderrPath, stderrStat.size, budgets.stderr)
    ]);
    const receipt = {
      schema_version: FLOW_SCHEMA_VERSION,
      command,
      cwd: options.cwd,
      started_at: startedAt,
      exit_code: result.status,
      signal: result.signal,
      timed_out: result.timedOut,
      duration_ms: durationMs,
      stdout,
      stderr,
      output_sha256: createHash("sha256").update(stdout.content).update(stderr.content).digest("hex"),
      ...(result.error ? { error: result.error.message } : {})
    };
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
    return {
      receipt,
      receiptPath,
      cleanup: () => rm(captureDir, { recursive: true, force: true })
    };
  } catch (error) {
    await rm(captureDir, { recursive: true, force: true });
    throw error;
  }
}
