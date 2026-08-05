import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { cliPath, execFile } from "./helpers/cli.mjs";

// Regression for #131: CLI commands must not flood stderr with AJV
// "unknown format" warnings (or any schema-compilation noise). Stderr
// is for real diagnostics; warning floods train users to ignore it.

async function runCli(args, options = {}) {
  try {
    const result = await execFile(process.execPath, [cliPath, ...args], options);
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

function assertNoSchemaWarnings(result, command) {
  const noise = result.stderr.split("\n").filter((line) => /unknown format|AJV|ajv/i.test(line));
  assert.deepEqual(noise, [], `${command} emitted schema-compilation warnings to stderr:\n${result.stderr}`);
}

test("flow --help emits no schema-compilation warnings", async () => {
  const result = await runCli(["--help"]);
  assert.equal(result.code, 0);
  assertNoSchemaWarnings(result, "flow --help");
});

test("flow init --demo and status emit no schema-compilation warnings", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "flow-131-stderr-"));
  const init = await runCli(["init", "--demo", "--cwd", cwd]);
  assert.equal(init.code, 0, init.stderr);
  assertNoSchemaWarnings(init, "flow init --demo");

  const status = await runCli(["status", "demo", "--cwd", cwd]);
  assert.equal(status.code, 0, status.stderr);
  assertNoSchemaWarnings(status, "flow status demo");

  const evaluate = await runCli(["evaluate", "demo", "--cwd", cwd]);
  assertNoSchemaWarnings(evaluate, "flow evaluate demo");
});

test("run-state and evidence-manifest schema validators are silent across separate processes", async () => {
  // Each CLI invocation above constructs fresh Ajv instances per compiled
  // schema (module-level caches are per-process), so the three-command
  // sequence already covers the multi-instance warning path that produced
  // the original ~36-warning flood. Assert stderr is EMPTY, not merely
  // free of format warnings, for the healthy commands.
  const cwd = await mkdtemp(path.join(tmpdir(), "flow-131-stderr-empty-"));
  const init = await runCli(["init", "--demo", "--cwd", cwd]);
  assert.equal(init.code, 0, init.stderr);
  assert.equal(init.stderr, "", `flow init --demo wrote to stderr:\n${init.stderr}`);

  const status = await runCli(["status", "demo", "--cwd", cwd]);
  assert.equal(status.code, 0, status.stderr);
  assert.equal(status.stderr, "", `flow status wrote to stderr:\n${status.stderr}`);
});
