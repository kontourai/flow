import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

async function packFiles() {
  const { stdout } = await execFileAsync("npm", [
    "pack",
    "--dry-run",
    "--ignore-scripts",
    "--json",
    "--cache",
    `${tmpdir()}/flow-npm-cache`
  ], {
    cwd: new URL("../..", import.meta.url)
  });
  const [pack] = JSON.parse(stdout);
  assert.ok(pack, "npm pack must return package metadata");
  return new Set(pack.files.map((file) => file.path));
}

function reservedAgentWorkspaceSegment() {
  return [".agent", "s"].join("");
}

async function trackedExampleFiles() {
  const { stdout } = await execFileAsync("git", ["ls-files", "-z", "examples"], {
    cwd: repoRoot
  });
  return stdout
    .split("\0")
    .filter(Boolean)
    .sort();
}

test("npm package publishes only the intended top-level surfaces", async () => {
  const files = await packFiles();
  const topLevel = new Set([...files].map((file) => file.split("/")[0]));

  assert.deepEqual([...topLevel].sort(), [
    "CHANGELOG.md",
    "LICENSE",
    "README.md",
    "dist",
    "examples",
    "package.json",
    "schemas"
  ]);

  for (const file of files) {
    assert.ok(!file.startsWith("src/"), `${file} must not publish TypeScript source`);
    assert.ok(!file.startsWith("scripts/"), `${file} must not publish repo scripts`);
    assert.ok(!file.startsWith("tests/"), `${file} must not publish tests`);
    assert.ok(!file.startsWith(".github/"), `${file} must not publish GitHub workflows`);
    assert.ok(!file.startsWith(".githooks/"), `${file} must not publish contributor hooks`);
    assert.ok(!file.startsWith(".flow-agents/"), `${file} must not publish workflow artifacts`);
    assert.ok(!file.includes(reservedAgentWorkspaceSegment()), `${file} must not publish agent workspace artifacts`);
  }
});

test("npm package includes exactly the tracked public examples", async () => {
  const files = await packFiles();
  const expected = await trackedExampleFiles();
  const actual = [...files]
    .filter((file) => file.startsWith("examples/"))
    .sort();

  assert.deepEqual(actual, expected);
});

test("published scenario directories have user-facing README coverage", async () => {
  const files = await packFiles();
  const scenarioDirs = new Set(
    [...files]
      .filter((file) => file.startsWith("examples/scenarios/"))
      .map((file) => file.split("/").slice(0, 3).join("/"))
  );

  for (const dir of scenarioDirs) {
    assert.ok(files.has(`${dir}/README.md`), `${dir} must include README.md`);
  }
});
