import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

async function filesBelow(root, relative = "") {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...await filesBelow(root, child));
    else if (entry.isFile()) files.push(child.split(path.sep).join("/"));
  }
  return files;
}

/** Byte-exact, path-sorted snapshot of every regular file in a run directory. */
export async function snapshotRunTree(root) {
  const snapshot = new Map();
  for (const relative of await filesBelow(root)) {
    snapshot.set(relative, await readFile(path.join(root, relative)));
  }
  return snapshot;
}

/** Stable hash over both relative paths and exact file bytes. */
export async function hashRunTree(root) {
  const hash = createHash("sha256");
  for (const [relative, bytes] of await snapshotRunTree(root)) {
    const pathBytes = Buffer.from(relative, "utf8");
    const lengths = Buffer.alloc(16);
    lengths.writeBigUInt64BE(BigInt(pathBytes.length), 0);
    lengths.writeBigUInt64BE(BigInt(bytes.length), 8);
    hash.update(lengths).update(pathBytes).update(bytes);
  }
  return hash.digest("hex");
}

export const lifecycleStateMatrix = Object.freeze({
  pause: Object.freeze({ allowed: ["active", "blocked", "needs_decision"], rejected: ["paused", "canceled", "completed", "failed", "accepted_by_exception"] }),
  resume: Object.freeze({ allowed: ["paused"], rejected: ["active", "blocked", "needs_decision", "canceled", "completed", "failed", "accepted_by_exception"] }),
  cancel: Object.freeze({ allowed: ["active", "blocked", "needs_decision", "paused"], rejected: ["canceled", "completed", "failed", "accepted_by_exception"] }),
  evaluate: Object.freeze({ rejected: ["paused", "canceled"] }),
  advance: Object.freeze({ rejected: ["paused", "canceled"] })
});
