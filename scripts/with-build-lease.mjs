import { spawn } from "node:child_process";
import { acquireBuildLease } from "./lib/build-lease.mjs";

const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error("with-build-lease requires a command");
const lease = await acquireBuildLease();
try {
  const code = await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      env: { ...process.env, KONTOUR_FLOW_BUILD_LEASE_TOKEN: lease.token },
    });
    child.once("error", reject);
    child.once("exit", (exitCode, signal) => resolve(signal ? 1 : exitCode ?? 1));
  });
  process.exitCode = code;
} finally {
  await lease.release();
}
