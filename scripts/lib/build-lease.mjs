import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const lockName = createHash("sha256").update(root).digest("hex").slice(0, 20);
const lockDir = path.join(tmpdir(), `kontourai-flow-build-${lockName}.lock`);
const ownerFile = path.join(lockDir, "owner.json");

export async function acquireBuildLease(timeoutMs = 120_000) {
  const inheritedToken = process.env.KONTOUR_FLOW_BUILD_LEASE_TOKEN;
  if (inheritedToken) {
    const owner = await readOwner();
    if (owner?.token !== inheritedToken || !processAlive(owner.pid)) throw new Error("inherited Flow build lease is not live");
    return { token: inheritedToken, release: async () => {} };
  }

  const token = randomUUID();
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      await mkdir(lockDir);
      await writeFile(ownerFile, `${JSON.stringify({ pid: process.pid, token })}\n`, { flag: "wx", mode: 0o600 });
      return {
        token,
        release: async () => {
          const owner = await readOwner();
          if (owner?.pid === process.pid && owner?.token === token) await rm(lockDir, { recursive: true, force: true });
        },
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      await removeStaleLock();
      if (Date.now() >= deadline) throw new Error(`timed out waiting for Flow build lease ${lockDir}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

async function readOwner() {
  try {
    return JSON.parse(await readFile(ownerFile, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function removeStaleLock() {
  const owner = await readOwner();
  if (!owner) {
    const lockStat = await stat(lockDir).catch(() => null);
    if (lockStat && Date.now() - lockStat.mtimeMs > 5_000) await rm(lockDir, { recursive: true, force: true });
    return;
  }
  if (!Number.isSafeInteger(owner.pid) || owner.pid < 1 || !processAlive(owner.pid)) {
    await rm(lockDir, { recursive: true, force: true });
  }
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "EPERM") return true;
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}
