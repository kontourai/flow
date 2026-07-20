import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lockName = createHash("sha256").update(root).digest("hex").slice(0, 20);
const lockDir = path.join(tmpdir(), `kontourai-flow-build-${lockName}.lock`);
const ownerFile = path.join(lockDir, "owner.json");
const token = randomUUID();
const deadline = Date.now() + 120_000;

await acquire();
try {
  await run(process.execPath, [path.join(root, "scripts", "sync-ui-assets.mjs")]);
  await run(path.join(root, "node_modules", ".bin", "tsc"), []);
  await run(path.join(root, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.console-ui.json"]);
  await run(process.execPath, [path.join(root, "scripts", "copy-console-ui.mjs")]);
} finally {
  await release();
}

async function acquire() {
  while (true) {
    try {
      await mkdir(lockDir);
      await writeFile(ownerFile, `${JSON.stringify({ pid: process.pid, token })}\n`, { flag: "wx", mode: 0o600 });
      return;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      await removeStaleLock();
      if (Date.now() >= deadline) throw new Error(`timed out waiting for Flow build lock ${lockDir}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

async function removeStaleLock() {
  let owner;
  try {
    owner = JSON.parse(await readFile(ownerFile, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      const lockStat = await stat(lockDir).catch(() => null);
      if (lockStat && Date.now() - lockStat.mtimeMs > 5_000) await rm(lockDir, { recursive: true, force: true });
      return;
    }
    throw error;
  }
  if (!Number.isSafeInteger(owner?.pid) || owner.pid < 1) return;
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    if (error?.code === "ESRCH") await rm(lockDir, { recursive: true, force: true });
    else if (error?.code !== "EPERM") throw error;
  }
}

async function release() {
  try {
    const owner = JSON.parse(await readFile(ownerFile, "utf8"));
    if (owner?.pid === process.pid && owner?.token === token) await rm(lockDir, { recursive: true, force: true });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
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
