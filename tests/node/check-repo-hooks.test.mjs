import assert from "node:assert/strict";
import { access, constants, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const hookPath = new URL("../../.githooks/pre-push", import.meta.url);
const gitignorePath = new URL("../../.gitignore", import.meta.url);
const contributingPath = new URL("../../docs/contributing.md", import.meta.url);
const packagePath = new URL("../../package.json", import.meta.url);
const readmePath = new URL("../../README.md", import.meta.url);
const consoleSmokePath = new URL("../../scripts/check-console-smoke.mjs", import.meta.url);
const browserServerPath = new URL("../../tests/browser/serve-flow-console.mjs", import.meta.url);
const setupPath = new URL("../../scripts/setup-repo-hooks.mjs", import.meta.url);
const validatePath = new URL("../../scripts/validate-repo-hooks.mjs", import.meta.url);
const buildLeaseWrapperPath = new URL("../../scripts/with-build-lease.mjs", import.meta.url);

const downstreamNamePatterns = [
  ["Camp", "fit"],
  ["T", "axes"],
  [".kontour/"],
  ["downstream", " app"],
  ["private", " product"]
];

async function text(url) {
  return readFile(url, "utf8");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function meaningfulShellLines(content) {
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

test("gitignore preserves durable Flow state and ignores generated product state", async () => {
  const gitignore = await text(gitignorePath);
  assert.match(gitignore, /^\.kontourai\/$/m);
  assert.doesNotMatch(gitignore, /^(?:\/)?\.flow(?:\/|$)/m, "all .flow content must remain visible for authored state or explicit migration");
  assert.doesNotMatch(gitignore, /^(?:\/)?\.(?:flow-agents|surface|veritas)(?:\/|$)/m, "product state uses the common .kontourai boundary");
});

test("console smoke output uses the Flow product namespace", async () => {
  const consoleSmoke = await text(consoleSmokePath);
  const browserServer = await text(browserServerPath);
  assert.match(consoleSmoke, /"\.kontourai", "flow", "console-smoke"/);
  assert.match(consoleSmoke, /mkdtemp\(path\.join\(tmpdir\(\), "kontourai-flow-console-smoke-"\)\)/);
  assert.match(browserServer, /browserTestRoot, "\.kontourai", "flow", "test-projects", "console-projection"/);
  assert.match(browserServer, /FLOW_CONSOLE_TEST_PORT/);
  assert.doesNotMatch(consoleSmoke, /\.flow-agents/);
  assert.doesNotMatch(`${consoleSmoke}\n${browserServer}`, /rm\(fixtureRunDir/);
});

test("browser server rejects and preserves an unowned caller-supplied root", async () => {
  const unownedRoot = await mkdtemp(path.join(tmpdir(), "kontourai-flow-browser-unowned-"));
  const sentinel = path.join(unownedRoot, "keep.txt");
  await writeFile(path.join(unownedRoot, ".flow-browser-owner.json"), `${JSON.stringify({ token: "different-owner" })}\n`);
  await writeFile(sentinel, "preserve\n");
  try {
    const result = spawnSync(process.execPath, [fileURLToPath(browserServerPath)], {
      encoding: "utf8",
      env: {
        ...process.env,
        FLOW_CONSOLE_TEST_ROOT: unownedRoot,
        FLOW_CONSOLE_TEST_OWNER_TOKEN: "untrusted-caller",
        FLOW_CONSOLE_TEST_PORT: "4184",
      },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ownership marker does not match/);
    assert.equal(await readFile(sentinel, "utf8"), "preserve\n");
  } finally {
    await rm(unownedRoot, { recursive: true, force: true });
  }
});

test("repo hook package scripts stay wired", async () => {
  const packageJson = JSON.parse(await text(packagePath));

  assert.equal(packageJson.scripts["setup:repo-hooks"], "node scripts/setup-repo-hooks.mjs");
  assert.equal(packageJson.scripts["validate:repo-hooks"], "node scripts/validate-repo-hooks.mjs");
  assert.equal(packageJson.scripts["check:repo-hooks"], "node scripts/with-build-lease.mjs npm run check:repo-hooks:locked");
  assert.equal(packageJson.scripts["test:node"], "node scripts/with-build-lease.mjs npm run test:node:locked");
  assert.equal(packageJson.scripts["test:node:locked"], "node --test tests/node/*.test.mjs");
  assert.equal(packageJson.scripts.build, "node scripts/build.mjs");
  assert.equal(packageJson.scripts.test, "node scripts/with-build-lease.mjs npm run test:locked");
  assert.match(packageJson.scripts["test:locked"], /tests\/node\/\*\.test\.mjs/);
  assert.doesNotMatch(packageJson.scripts.test, /scripts\/check-(schemas|repo-hooks|console-projection|package-contents)\.mjs/);
});

test("terminating the build-lease wrapper terminates its child process group before releasing the lease", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "flow-build-lease-signal-"));
  const ready = path.join(root, "ready");
  const childPidFile = path.join(root, "child-pid");
  const descendantScript = [
    'const fs = require("node:fs")',
    'process.on("SIGTERM", () => {})',
    `fs.writeFileSync(${JSON.stringify(ready)}, "ready\\n")`,
    'setInterval(() => {}, 1000)',
  ].join(";");
  const childScript = [
    'const fs = require("node:fs")',
    'const { spawn } = require("node:child_process")',
    `const descendant = spawn(process.execPath, ["-e", ${JSON.stringify(descendantScript)}], { stdio: "ignore" })`,
    `fs.writeFileSync(${JSON.stringify(childPidFile)}, String(descendant.pid))`,
    'setInterval(() => {}, 1000)',
  ].join(";");
  const wrapper = spawn(process.execPath, [fileURLToPath(buildLeaseWrapperPath), process.execPath, "-e", childScript], {
    stdio: "ignore",
  });

  try {
    await waitForFile(ready);
    const childPid = Number(await readFile(childPidFile, "utf8"));
    wrapper.kill("SIGTERM");
    const result = await waitForExit(wrapper);
    assert.equal(result.code, 143);
    await waitForProcessExit(childPid);

    const startedAt = Date.now();
    const next = spawnSync(process.execPath, [fileURLToPath(buildLeaseWrapperPath), process.execPath, "-e", ""], {
      encoding: "utf8",
      timeout: 5_000,
    });
    assert.equal(next.status, 0, next.stderr);
    assert.ok(Date.now() - startedAt < 2_000, "the released lease should be immediately reusable");
  } finally {
    if (wrapper.exitCode === null && wrapper.signalCode === null) wrapper.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
});

async function waitForFile(file, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(file);
      return;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error(`timed out waiting for ${file}`);
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

async function waitForProcessExit(pid, timeoutMs = 7_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await new Promise((resolve) => setTimeout(resolve, 25));
    } catch (error) {
      if (error?.code === "ESRCH") return;
      throw error;
    }
  }
  throw new Error(`child process ${pid} remained alive after wrapper termination`);
}

test("pre-push hook is executable and runs the bounded local lane", async () => {
  const hook = await text(hookPath);
  const hookStat = await stat(hookPath);
  const expectedLines = [
    "set -eu",
    "repo_root=$(git rev-parse --show-toplevel)",
    'cd "$repo_root"',
    "unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX GIT_COMMON_DIR \\",
    "GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_NAMESPACE \\",
    "GIT_QUARANTINE_PATH GIT_QUARANTINE_ID",
    'echo "pre-push: npm test"',
    "npm test",
    'echo "pre-push: npm run check:schemas"',
    "npm run check:schemas"
  ];

  await access(hookPath, constants.X_OK);
  assert.ok(hookStat.isFile(), ".githooks/pre-push must be a file");
  assert.match(hook, /^#!\/bin\/sh\n/);
  assert.deepEqual(meaningfulShellLines(hook), expectedLines);
});

test("setup and validation scripts use repo-local hooks path", async () => {
  const setup = await text(setupPath);
  const validate = await text(validatePath);

  assert.match(setup, /"config", "--local", "core\.hooksPath", "\.githooks"/);
  assert.doesNotMatch(setup, /--global|--system/);
  assert.match(validate, /\.\.\/tests\/node\/check-repo-hooks\.test\.mjs/);
  assert.doesNotMatch(validate, /scripts\/check-repo-hooks\.mjs|\.\/check-repo-hooks\.mjs/);
  assert.match(validate, /"config", "--local", "--get", "core\.hooksPath"/);
  assert.match(validate, /\.githooks/);
  assert.match(validate, /pre-push/);
});

test("README points contributors to repo-local setup docs", async () => {
  const readme = await text(readmePath);

  assert.match(readme, /docs\/contributing\.md/);
  assert.doesNotMatch(readme, /## Contributor Git Hooks/);
  assert.doesNotMatch(readme, /npm run setup:repo-hooks/);
});

test("contributing docs cover hook setup and product boundary", async () => {
  const contributing = await text(contributingPath);

  assert.match(contributing, /## Optional Git Hooks/);
  assert.match(contributing, /npm run setup:repo-hooks/);
  assert.match(contributing, /npm run validate:repo-hooks/);
  assert.match(contributing, /contributor tooling/);
  assert.match(contributing, /not Flow Definition semantics/);
  assert.match(contributing, /not Flow Run state/);
  assert.match(contributing, /not gate evaluation/);
  assert.match(contributing, /not Flow Console behavior/);
  assert.match(contributing, /not CI or merge authority/);
  assert.doesNotMatch(contributing, /\.flow-agents\//);
});

test("repo hook files do not mention downstream or private product names", async () => {
  const files = [
    ["package.json", await text(packagePath)],
    ["README.md", await text(readmePath)],
    ["docs/contributing.md", await text(contributingPath)],
    [".githooks/pre-push", await text(hookPath)],
    ["scripts/setup-repo-hooks.mjs", await text(setupPath)],
    ["scripts/validate-repo-hooks.mjs", await text(validatePath)]
  ];

  for (const [file, contents] of files) {
    for (const parts of downstreamNamePatterns) {
      const name = parts.join("");
      assert.doesNotMatch(contents, new RegExp(escapeRegExp(name), "i"), `${file} must not mention ${name}`);
    }
  }
});
