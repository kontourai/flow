import { spawn } from "node:child_process";
import { acquireBuildLease } from "./lib/build-lease.mjs";

const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error("with-build-lease requires a command");
const lease = await acquireBuildLease();
let child;
let forwardedSignal;
let escalationTimer;
const signalExitCodes = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };
const forwardSignal = (signal) => {
  forwardedSignal ??= signal;
  if (!child || child.killed) return;
  signalChildTree(signal);
  escalationTimer ??= setTimeout(() => signalChildTree("SIGKILL"), 5_000);
};
const signalHandlers = Object.fromEntries(Object.keys(signalExitCodes).map((signal) => [signal, () => forwardSignal(signal)]));
for (const [signal, handler] of Object.entries(signalHandlers)) process.on(signal, handler);
try {
  const code = await new Promise((resolve, reject) => {
    child = spawn(command, args, {
      stdio: "inherit",
      detached: process.platform !== "win32",
      env: { ...process.env, KONTOUR_FLOW_BUILD_LEASE_TOKEN: lease.token },
    });
    child.once("error", reject);
    child.once("exit", async (exitCode, signal) => {
      try {
        if (forwardedSignal && process.platform !== "win32") await waitForProcessGroupExit(child.pid);
        resolve(forwardedSignal ? signalExitCodes[forwardedSignal] : signal ? 128 : exitCode ?? 1);
      } catch (error) {
        reject(error);
      }
    });
  });
  process.exitCode = code;
} finally {
  if (escalationTimer) clearTimeout(escalationTimer);
  for (const [signal, handler] of Object.entries(signalHandlers)) process.off(signal, handler);
  await lease.release();
}

function signalChildTree(signal) {
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") child.kill(signal);
  }
}

async function waitForProcessGroupExit(pid) {
  while (true) {
    try {
      process.kill(-pid, 0);
      await new Promise((resolve) => setTimeout(resolve, 25));
    } catch (error) {
      if (error?.code === "ESRCH") return;
      throw error;
    }
  }
}
