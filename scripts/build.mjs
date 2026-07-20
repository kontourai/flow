import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { acquireBuildLease } from "./lib/build-lease.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lease = await acquireBuildLease();
try {
  await run(process.execPath, [path.join(root, "scripts", "sync-ui-assets.mjs")]);
  await run(path.join(root, "node_modules", ".bin", "tsc"), []);
  await run(path.join(root, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.console-ui.json"]);
  await run(process.execPath, [path.join(root, "scripts", "copy-console-ui.mjs")]);
} finally {
  await lease.release();
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(command)} failed${signal ? ` with ${signal}` : ` with exit code ${code}`}`));
    });
  });
}
