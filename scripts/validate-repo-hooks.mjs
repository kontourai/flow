import { execFileSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function fail(message) {
  console.error(`validate:repo-hooks: ${message}`);
  process.exit(1);
}

try {
  git(["rev-parse", "--is-inside-work-tree"]);
  const repoRoot = git(["rev-parse", "--show-toplevel"]);
  process.chdir(repoRoot);

  execFileSync(process.execPath, ["--test", fileURLToPath(new URL("./check-repo-hooks.mjs", import.meta.url))], {
    stdio: "inherit"
  });

  const hookPath = path.join(repoRoot, ".githooks", "pre-push");
  if (!statSync(hookPath).isFile()) {
    fail(".githooks/pre-push is not a file");
  }
  accessSync(hookPath, constants.X_OK);

  const hooksPath = git(["config", "--local", "--get", "core.hooksPath"]);
  if (hooksPath !== ".githooks") {
    fail(`expected local core.hooksPath=.githooks, got ${JSON.stringify(hooksPath)}`);
  }

  console.log("validate:repo-hooks: local hooks are configured");
} catch (error) {
  fail(error.message);
}
