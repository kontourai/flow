/**
 * flow#248 — directory fsync is a POSIX-only durability refinement. Windows
 * answers EPERM for fsync on a directory handle, which made every
 * publishRunArtifacts call throw on win32; the classifier below is what keeps
 * the publish proceeding there while real failures stay loud.
 */
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  directorySyncUnsupported,
  syncDirectory
} from "../../dist/runtime/flow-files.js";

test("classifies the platform refusals and nothing else", () => {
  for (const code of ["EPERM", "EINVAL", "ENOTSUP"]) {
    assert.equal(
      directorySyncUnsupported(Object.assign(new Error(code), { code })),
      true
    );
  }
  for (const code of ["EACCES", "ENOENT", "EIO", undefined]) {
    assert.equal(
      directorySyncUnsupported(Object.assign(new Error(String(code)), { code })),
      false
    );
  }
  assert.equal(directorySyncUnsupported(null), false);
  assert.equal(directorySyncUnsupported("not an error"), false);
});

test("syncDirectory still syncs a real directory where the platform allows it", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "flow-dirsync-"));
  await assert.doesNotReject(() => syncDirectory(dir));
});
