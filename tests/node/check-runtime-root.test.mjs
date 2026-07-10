import assert from "node:assert/strict";
import {
  access,
  chmod,
  constants,
  mkdtemp,
  mkdir,
  readFile,
  rename,
  symlink,
  unlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import * as flow from "../../dist/index.js";
import { execFile } from "./helpers/cli.mjs";
import { json } from "./helpers/fixtures.mjs";

const definitionPath = new URL("../../examples/agent-dev-flow.json", import.meta.url).pathname;
const cliPath = new URL("../../dist/cli.js", import.meta.url).pathname;

function canonicalRunDir(cwd, runId) {
  return path.join(cwd, ".kontourai", "flow", "runs", runId);
}

function legacyRunDir(cwd, runId) {
  return path.join(cwd, ".flow", "runs", runId);
}

async function exists(file) {
  try {
    await access(file, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function writeCompleteRun(dir, runId, suppliedDefinition) {
  const definition = suppliedDefinition ?? await json("examples/agent-dev-flow.json");
  const state = flow.initialState(definition, runId, { subject: `subject-${runId}` });
  const manifest = {
    schema_version: flow.FLOW_SCHEMA_VERSION,
    run_id: runId,
    definition_id: definition.id,
    definition_version: definition.version,
    evidence: []
  };
  await mkdir(path.join(dir, "evidence"), { recursive: true });
  await writeFile(path.join(dir, "definition.json"), `${JSON.stringify(definition, null, 2)}\n`);
  await writeFile(path.join(dir, "state.json"), `${JSON.stringify(state, null, 2)}\n`);
  await writeFile(path.join(dir, "evidence", "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return { definition, state, manifest };
}

test("AC-111-01 writes generated state only under .kontourai/flow and keeps authored .flow state Git-visible", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "flow-runtime-root-new-"));
  await flow.ensureFlowLayout(cwd);
  const result = await flow.startRun(definitionPath, { cwd, runId: "canonical-new" });

  assert.equal(flow.flowRoot(cwd), path.join(cwd, ".flow"));
  assert.equal(flow.flowConfigPath(cwd), path.join(cwd, ".flow", "config.json"));
  assert.equal(flow.flowRuntimeRoot(cwd), path.join(cwd, ".kontourai", "flow"));
  assert.equal(flow.runDir("canonical-new", cwd), canonicalRunDir(cwd, "canonical-new"));
  assert.equal(result.dir, canonicalRunDir(cwd, "canonical-new"));
  await access(path.join(cwd, ".flow", "config.json"), constants.R_OK);
  await access(path.join(cwd, ".flow", "definitions", "agent-dev-flow.json"), constants.R_OK);
  assert.equal(await exists(legacyRunDir(cwd, "canonical-new")), false);
  for (const file of ["definition.json", "state.json", "evidence/manifest.json", "report.json", "report.md"]) {
    await access(path.join(result.dir, file), constants.R_OK);
  }
});

test("AC-111-02 does not discover or mutate runs that exist only under legacy .flow/runs", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "flow-runtime-no-legacy-"));
  const legacyDir = legacyRunDir(cwd, "old-run");
  await writeCompleteRun(legacyDir, "old-run");

  await assert.rejects(() => flow.loadRun("old-run", cwd), /flow\.run_location\.not_found/);
  assert.deepEqual(await flow.listRuns(cwd), []);
  await assert.rejects(
    () => flow.acceptException("old-run", { cwd, gate: "plan-gate", reason: "no fallback", authority: "test" }),
    /flow\.run_location\.not_found/
  );
  assert.equal(await exists(canonicalRunDir(cwd, "old-run")), false);
  const state = JSON.parse(await readFile(path.join(legacyDir, "state.json"), "utf8"));
  assert.deepEqual(state.exceptions, []);
});

test("AC-111-02 new allocation ignores legacy ids but rejects canonical collisions", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "flow-runtime-allocation-"));
  await writeCompleteRun(legacyRunDir(cwd, "same-id"), "same-id");
  const started = await flow.startRun(definitionPath, { cwd, runId: "same-id" });
  assert.equal(started.dir, canonicalRunDir(cwd, "same-id"));
  await assert.rejects(
    () => flow.startRun(definitionPath, { cwd, runId: "same-id" }),
    /flow\.run_location\.allocation_collision/
  );
});

test("AC-111-04 new-run allocation claims one run id exclusively", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "flow-runtime-concurrent-allocation-"));
  const attempts = await Promise.allSettled([
    flow.startRun(definitionPath, { cwd, runId: "exclusive-run" }),
    flow.startRun(definitionPath, { cwd, runId: "exclusive-run" })
  ]);
  assert.equal(attempts.filter((entry) => entry.status === "fulfilled").length, 1);
  assert.equal(attempts.filter((entry) => entry.status === "rejected").length, 1);
  assert.match(String(attempts.find((entry) => entry.status === "rejected").reason), /flow\.run_location\.allocation_collision/);
  assert.equal((await flow.loadRun("exclusive-run", cwd)).state.run_id, "exclusive-run");
});

test("AC-111-04 run ids are one path segment", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "flow-runtime-run-id-"));
  for (const runId of ["nested/id", "nested\\id", "../outside"]) {
    assert.throws(() => flow.runDir(runId, cwd), /invalid run id/);
    await assert.rejects(() => flow.startRun(definitionPath, { cwd, runId }), /invalid run id/);
  }
});

test("AC-111-04 init refuses linked authored-file destinations", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "flow-runtime-authored-link-"));
  const outside = path.join(cwd, "outside-definition.json");
  const marker = "do not overwrite\n";
  await writeFile(outside, marker);
  await mkdir(path.join(cwd, ".flow", "definitions"), { recursive: true });
  await symlink(outside, path.join(cwd, ".flow", "definitions", "agent-dev-flow.json"));
  await assert.rejects(() => flow.ensureFlowLayout(cwd), /flow\.run_location\.symlink_not_allowed/);
  assert.equal(await readFile(outside, "utf8"), marker);
});

test("AC-111-04 rejects a symlink supplied as the project cwd", async () => {
  const target = await mkdtemp(path.join(tmpdir(), "flow-runtime-cwd-target-"));
  const linkedCwd = `${target}-link`;
  await symlink(target, linkedCwd, "dir");
  try {
    await assert.rejects(
      () => flow.startRun(definitionPath, { cwd: linkedCwd, runId: "linked-cwd" }),
      /flow\.run_location\.unsafe_working_directory/
    );
    assert.equal(await exists(path.join(target, ".kontourai")), false);
  } finally {
    await unlink(linkedCwd);
  }
});

test("AC-111-04 fails closed for unreadable, malformed, and ancestor-linked canonical roots", async (t) => {
  const malformedCwd = await mkdtemp(path.join(tmpdir(), "flow-runtime-malformed-root-"));
  await mkdir(path.join(malformedCwd, ".kontourai"), { recursive: true });
  await writeFile(path.join(malformedCwd, ".kontourai", "flow"), "not a directory\n");
  await assert.rejects(
    () => flow.startRun(definitionPath, { cwd: malformedCwd, runId: "malformed-root" }),
    /flow\.run_location\.inspection_failed/
  );

  const linkedCwd = await mkdtemp(path.join(tmpdir(), "flow-runtime-linked-root-"));
  const external = await mkdtemp(path.join(tmpdir(), "flow-runtime-linked-external-"));
  await symlink(external, path.join(linkedCwd, ".kontourai"), "dir");
  await assert.rejects(
    () => flow.startRun(definitionPath, { cwd: linkedCwd, runId: "linked-root" }),
    /flow\.run_location\.inspection_failed/
  );
  assert.equal(await exists(path.join(external, "flow", "runs", "linked-root", "state.json")), false);

  if (process.platform === "win32" || (typeof process.getuid === "function" && process.getuid() === 0)) {
    t.diagnostic("POSIX unreadable-root assertion skipped for this process");
    return;
  }
  const unreadableCwd = await mkdtemp(path.join(tmpdir(), "flow-runtime-unreadable-root-"));
  const runtimeRoot = path.join(unreadableCwd, ".kontourai", "flow", "runs");
  await mkdir(runtimeRoot, { recursive: true });
  await chmod(runtimeRoot, 0o000);
  try {
    await assert.rejects(
      () => flow.startRun(definitionPath, { cwd: unreadableCwd, runId: "unreadable-root" }),
      /flow\.run_location\.inspection_failed/
    );
  } finally {
    await chmod(runtimeRoot, 0o700);
  }
});

test("AC-111-04 rejects linked run directories and structurally invalid manifests", async () => {
  const linkedCwd = await mkdtemp(path.join(tmpdir(), "flow-runtime-linked-run-"));
  const external = await mkdtemp(path.join(tmpdir(), "flow-runtime-run-external-"));
  await writeCompleteRun(external, "linked-run");
  await mkdir(path.dirname(canonicalRunDir(linkedCwd, "linked-run")), { recursive: true });
  await symlink(external, canonicalRunDir(linkedCwd, "linked-run"), "dir");
  await assert.rejects(() => flow.loadRun("linked-run", linkedCwd), /flow\.run_location\.no_complete_candidate/);

  const manifestCwd = await mkdtemp(path.join(tmpdir(), "flow-runtime-invalid-manifest-"));
  const manifestDir = canonicalRunDir(manifestCwd, "invalid-manifest");
  const { manifest } = await writeCompleteRun(manifestDir, "invalid-manifest");
  await writeFile(path.join(manifestDir, "evidence", "manifest.json"), `${JSON.stringify({
    ...manifest,
    evidence: [42]
  }, null, 2)}\n`);
  await assert.rejects(() => flow.loadRun("invalid-manifest", manifestCwd), /flow\.run_location\.no_complete_candidate/);
  await writeFile(path.join(manifestDir, "evidence", "manifest.json"), `${JSON.stringify({
    ...manifest,
    unexpected: true
  }, null, 2)}\n`);
  await assert.rejects(() => flow.loadRun("invalid-manifest", manifestCwd), /gate-evidence\.schema\.json/);
});

test("AC-111-04 rejects schema-invalid canonical run state", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "flow-runtime-invalid-state-"));
  const dir = canonicalRunDir(cwd, "invalid-state");
  const { state } = await writeCompleteRun(dir, "invalid-state");
  await writeFile(path.join(dir, "state.json"), `${JSON.stringify({
    ...state,
    gate_outcomes: "not-an-array",
    transitions: null,
    exceptions: 42
  }, null, 2)}\n`);
  await assert.rejects(() => flow.loadRun("invalid-state", cwd), /flow\.run_location\.no_complete_candidate/);
});

test("AC-111-04 enforces published date-time formats for state and manifest", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "flow-runtime-invalid-time-"));
  const dir = canonicalRunDir(cwd, "invalid-time");
  const { state, manifest } = await writeCompleteRun(dir, "invalid-time");
  await writeFile(path.join(dir, "state.json"), `${JSON.stringify({ ...state, updated_at: "not-a-date" }, null, 2)}\n`);
  await assert.rejects(() => flow.loadRun("invalid-time", cwd), /flow-run\.schema\.json/);

  await writeFile(path.join(dir, "state.json"), `${JSON.stringify(state, null, 2)}\n`);
  await writeFile(path.join(dir, "evidence", "manifest.json"), `${JSON.stringify({
    ...manifest,
    evidence: [{
      id: "ev.invalid-time",
      gate_id: "plan-gate",
      kind: "file",
      requested_kind: "file",
      status: "passed",
      attached_at: "not-a-date"
    }]
  }, null, 2)}\n`);
  await assert.rejects(() => flow.loadRun("invalid-time", cwd), /gate-evidence\.schema\.json/);
});

test("AC-111-04 list exposes corrupt canonical candidates instead of hiding them", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "flow-runtime-list-corrupt-"));
  await mkdir(canonicalRunDir(cwd, "corrupt"), { recursive: true });
  await writeFile(path.join(canonicalRunDir(cwd, "corrupt"), "state.json"), "{ corrupt");

  const listed = await execFile(process.execPath, [cliPath, "list", "--cwd", cwd]);
  assert.match(`${listed.stdout}${listed.stderr}`, /flow\.run_location\.no_complete_candidate/);
});

test("AC-111-03 keeps mutations, reports, projections, sinks, and server artifacts in the canonical run", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "flow-runtime-canonical-lifecycle-"));
  const started = await flow.startRun(definitionPath, { cwd, runId: "canonical-lifecycle" });
  const evidenceFile = path.join(cwd, "evidence.txt");
  await writeFile(evidenceFile, "canonical evidence\n");

  await flow.attachEvidence("canonical-lifecycle", { cwd, gate: "plan-gate", file: evidenceFile });
  await flow.acceptException("canonical-lifecycle", {
    cwd,
    gate: "plan-gate",
    reason: "canonical contract",
    authority: "runtime-root-test"
  });
  await flow.evaluateRun("canonical-lifecycle", { cwd });
  const projection = await flow.projectFlowRunFromFiles("canonical-lifecycle", { cwd });
  await new flow.FileConsoleSink({ cwd }).emit(projection, { resolvedRunDir: started.dir });

  const realArtifacts = path.join(started.dir, "real-artifacts");
  await mkdir(realArtifacts);
  await writeFile(path.join(realArtifacts, "inside.txt"), "run-local but linked\n");
  await symlink(realArtifacts, path.join(started.dir, "linked-artifacts"), "dir");

  const server = await flow.startFlowConsoleServer({ runId: "canonical-lifecycle", cwd, port: 0 });
  try {
    const response = await fetch(new URL("artifacts/report.json", server.url));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).run_id, "canonical-lifecycle");
    assert.equal((await fetch(new URL("artifacts/linked-artifacts/inside.txt", server.url))).status, 404);

    const outside = path.join(cwd, "outside-secret.txt");
    await writeFile(outside, "not a run artifact\n");
    await symlink(outside, path.join(started.dir, "secret-link.txt"));
    assert.equal((await fetch(new URL("artifacts/secret-link.txt", server.url))).status, 404);

    const parked = `${started.dir}.parked`;
    const replacement = await mkdtemp(path.join(tmpdir(), "flow-runtime-server-replacement-"));
    await writeCompleteRun(replacement, "canonical-lifecycle");
    await writeFile(path.join(replacement, "replacement-secret.txt"), "must not be served\n");
    await rename(started.dir, parked);
    await symlink(replacement, started.dir, "dir");
    try {
      assert.equal((await fetch(new URL("artifacts/replacement-secret.txt", server.url))).status, 404);
    } finally {
      await unlink(started.dir);
      await rename(parked, started.dir);
    }
  } finally {
    await server.close();
  }

  await access(path.join(started.dir, "console-projection.json"), constants.R_OK);
  assert.equal(await exists(legacyRunDir(cwd, "canonical-lifecycle")), false);
});

test("AC-111-04 flow report refuses linked report artifacts", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "flow-runtime-report-link-"));
  const started = await flow.startRun(definitionPath, { cwd, runId: "linked-report" });
  const outside = path.join(cwd, "outside-report.json");
  await writeFile(outside, "{\"status\":\"external\",\"summary\":\"secret\"}\n");
  await unlink(path.join(started.dir, "report.json"));
  await symlink(outside, path.join(started.dir, "report.json"));

  await assert.rejects(
    () => execFile(process.execPath, [cliPath, "report", "linked-report", "--cwd", cwd]),
    /flow\.run_location\.symlink_not_allowed/
  );
});

test("AC-111-04 report and console surfaces derive identity from authoritative run state", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "flow-runtime-forged-report-"));
  const started = await flow.startRun(definitionPath, { cwd, runId: "report-owner" });
  await writeFile(path.join(started.dir, "report.json"), `${JSON.stringify({
    run_id: "other-run",
    definition_id: "other-definition",
    status: "completed",
    summary: "forged"
  })}\n`);

  const projection = await flow.projectFlowRunFromFiles("report-owner", { cwd });
  assert.equal(projection.report.json.run_id, "report-owner");
  assert.equal(projection.report.json.definition_id, started.state.definition_id);

  const result = await execFile(process.execPath, [cliPath, "report", "report-owner", "--format", "json", "--cwd", cwd]);
  const report = JSON.parse(result.stdout);
  assert.equal(report.run_id, "report-owner");
  assert.equal(report.definition_id, started.state.definition_id);
  assert.equal(JSON.parse(await readFile(path.join(started.dir, "report.json"), "utf8")).run_id, "report-owner");
});

test("AC-111-05 init --demo writes disposable evidence only under .kontourai/flow/demo and is canonical-idempotent", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "flow-runtime-demo-"));
  const first = await flow.scaffoldDemoRun(cwd);
  const second = await flow.scaffoldDemoRun(cwd);
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  await access(path.join(cwd, ".kontourai", "flow", "demo", "acceptance-bundle.json"), constants.R_OK);
  await access(canonicalRunDir(cwd, "demo"), constants.R_OK);
  assert.equal(await exists(path.join(cwd, ".flow", "demo")), false);
  assert.equal(await exists(legacyRunDir(cwd, "demo")), false);
});
