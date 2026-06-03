import { execFileSync } from "node:child_process";

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function fail(message) {
  console.error(`setup:repo-hooks: ${message}`);
  process.exit(1);
}

try {
  git(["rev-parse", "--is-inside-work-tree"]);
  const repoRoot = git(["rev-parse", "--show-toplevel"]);
  process.chdir(repoRoot);

  git(["config", "--local", "core.hooksPath", ".githooks"]);

  const hooksPath = git(["config", "--local", "--get", "core.hooksPath"]);
  if (hooksPath !== ".githooks") {
    fail(`expected local core.hooksPath to be .githooks, got ${JSON.stringify(hooksPath)}`);
  }

  console.log("setup:repo-hooks: configured local core.hooksPath=.githooks");
} catch (error) {
  fail(error.message);
}
