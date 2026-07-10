import assert from "node:assert/strict";
import { access, constants, readFile, stat } from "node:fs/promises";
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
  assert.match(browserServer, /"\.kontourai", "flow", "test-projects", "console-projection"/);
  assert.doesNotMatch(consoleSmoke, /\.flow-agents/);
  assert.doesNotMatch(`${consoleSmoke}\n${browserServer}`, /rm\(fixtureRunDir/);
});

test("repo hook package scripts stay wired", async () => {
  const packageJson = JSON.parse(await text(packagePath));

  assert.equal(packageJson.scripts["setup:repo-hooks"], "node scripts/setup-repo-hooks.mjs");
  assert.equal(packageJson.scripts["validate:repo-hooks"], "node scripts/validate-repo-hooks.mjs");
  assert.equal(packageJson.scripts["check:repo-hooks"], "node --test tests/node/check-repo-hooks.test.mjs");
  assert.equal(packageJson.scripts["test:node"], "node --test tests/node/*.test.mjs");
  assert.match(packageJson.scripts.test, /tests\/node\/\*\.test\.mjs/);
  assert.doesNotMatch(packageJson.scripts.test, /scripts\/check-(schemas|repo-hooks|console-projection|package-contents)\.mjs/);
});

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
