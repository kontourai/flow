/**
 * Task E — ConsoleSink seam.
 *
 * Flow owns the FlowConsoleProjection payload. A ConsoleSink only knows where to
 * PUT it:
 *   - FileConsoleSink   — writes it under the run dir (local, default).
 *   - HostedConsoleSink — POSTs the SAME payload to a configurable endpoint,
 *                         OFF by default, importing nothing from any console pkg.
 *
 * Also asserts the stable contract subpath (@kontourai/flow/console-contract)
 * re-exports the sink + projection types so console can consume them.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { access, constants, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  FileConsoleSink,
  HostedConsoleSink,
  createConsoleSink
} from "../../dist/console/console-sink.js";
import { projectFlowRunFromFiles, startRun } from "../../dist/index.js";

const definitionPath = new URL("../../examples/agent-dev-flow.json", import.meta.url).pathname;

function fakeProjection(runId = "sink-run", definitionId = "demo", definitionVersion = "1") {
  return {
    schema_version: "1",
    run: {
      run_id: runId,
      definition_id: definitionId,
      definition_version: definitionVersion,
      subject: null,
      status: "active",
      current_step: "verify",
      updated_at: "2026-06-16T00:00:00.000Z",
      params: {}
    },
    definition: { id: definitionId, version: definitionVersion, title: null },
    steps: [],
    current_step: "verify",
    open_gates: [],
    gates: [],
    expectations: [],
    evidence: [],
    exceptions: [],
    transitions: [],
    route_backs: [],
    external_links: [],
    next_action: null,
    continuation: "",
    report: null
  };
}

test("FileConsoleSink writes a projection to an explicitly resolved canonical run directory", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "flow-sink-"));
  const sink = new FileConsoleSink({ cwd });
  assert.equal(sink.kind, "file");

  const run = await startRun(definitionPath, { cwd, runId: "sink-run" });
  const projection = await projectFlowRunFromFiles(run.state.run_id, { cwd });
  await writeFile(path.join(cwd, ".flow"), "malformed opposing root\n");
  await sink.emit(projection, { resolvedRunDir: run.dir });

  const written = JSON.parse(
    await readFile(path.join(cwd, ".kontourai", "flow", "runs", "sink-run", "console-projection.json"), "utf8")
  );
  assert.deepEqual(written, projection, "the exact Flow-owned payload is written, unwrapped");
});

test("FileConsoleSink rejects a nonexistent run without context and does not create runtime storage", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "flow-sink-missing-"));
  const sink = new FileConsoleSink({ cwd });

  await assert.rejects(() => sink.emit(fakeProjection("missing-sink-run")), /flow\.run_location\.not_found/);
  await assert.rejects(access(path.join(cwd, ".kontourai"), constants.F_OK), /ENOENT/);
  await assert.rejects(access(path.join(cwd, ".flow", "runs", "missing-sink-run"), constants.F_OK), /ENOENT/);
});

test("FileConsoleSink rejects caller context outside the canonical runtime root", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "flow-sink-context-mismatch-"));
  const runId = "canonical-context-run";
  await startRun(definitionPath, { cwd, runId });
  const wrongDir = path.join(cwd, ".flow", "runs", runId);

  await assert.rejects(
    () => new FileConsoleSink({ cwd }).emit(fakeProjection(runId), { resolvedRunDir: wrongDir }),
    /flow\.console_sink\.resolved_run_dir_mismatch/
  );
  await assert.rejects(access(path.join(wrongDir, "console-projection.json"), constants.F_OK), /ENOENT/);
});

test("FileConsoleSink rejects authoritative filenames and mismatched projection identity", async () => {
  assert.throws(() => new FileConsoleSink({ fileName: "state.json" }), /non-authoritative/);
  assert.throws(() => new FileConsoleSink({ fileName: "STATE.json" }), /non-authoritative/);
  assert.throws(() => new FileConsoleSink({ fileName: "evidence/projection.json" }), /non-authoritative/);

  const cwd = await mkdtemp(path.join(tmpdir(), "flow-sink-identity-"));
  const run = await startRun(definitionPath, { cwd, runId: "sink-identity" });
  await assert.rejects(
    () => new FileConsoleSink({ cwd }).emit(fakeProjection(run.state.run_id, "wrong-definition", "1"), { resolvedRunDir: run.dir }),
    /flow\.console_sink\.projection_identity_mismatch/
  );
  const forgedDefinition = fakeProjection(run.state.run_id, run.state.definition_id, run.state.definition_version);
  forgedDefinition.definition.id = "wrong-definition";
  await assert.rejects(
    () => new FileConsoleSink({ cwd }).emit(forgedDefinition, { resolvedRunDir: run.dir }),
    /flow\.console_sink\.projection_identity_mismatch/
  );
  assert.equal(JSON.parse(await readFile(path.join(run.dir, "state.json"), "utf8")).run_id, "sink-identity");
});

test("createConsoleSink defaults to the file sink (hosted is never default)", () => {
  const sink = createConsoleSink();
  assert.equal(sink.kind, "file");
});

test("createConsoleSink requires an endpoint when mode is hosted", () => {
  assert.throws(() => createConsoleSink({ mode: "hosted" }), /requires `hosted.endpoint`/);
});

test("HostedConsoleSink POSTs the v1 ingest envelope to <base>/ingest/flow", async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 202, statusText: "Accepted" };
  };

  const sink = new HostedConsoleSink({
    endpoint: "https://console.example.test",
    authToken: "secret-token",
    headers: { "x-tenant": "acme" },
    fetchImpl: fakeFetch
  });
  assert.equal(sink.kind, "hosted");

  const projection = fakeProjection("hosted-run");
  await sink.emit(projection);

  assert.equal(calls.length, 1);
  // Base URL gets the /ingest/flow route appended.
  assert.equal(calls[0].url, "https://console.example.test/ingest/flow");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["content-type"], "application/json");
  assert.equal(calls[0].init.headers.authorization, "Bearer secret-token");
  assert.equal(calls[0].init.headers["x-tenant"], "acme");

  // The body is the v1 ingest CONTRACT envelope wrapping Flow's projection.
  // Flow owns `payload`; console wraps it in kontour.console.event on ingest.
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.contractVersion, "1");
  assert.equal(body.source, "flow");
  assert.equal(body.type, "flow.console.projection.1");
  assert.equal(body.idempotencyKey, "hosted-run:0", "idempotencyKey is <runId>:<seq>");
  assert.equal(body.occurredAt, projection.run.updated_at);
  assert.deepEqual(body.payload, projection, "Flow owns the payload, posted unwrapped inside the envelope");
});

test("HostedConsoleSink monotonically advances the idempotency sequence per emit", async () => {
  const keys = [];
  const fakeFetch = async (_url, init) => {
    keys.push(JSON.parse(init.body).idempotencyKey);
    return { ok: true, status: 202, statusText: "Accepted" };
  };
  const sink = new HostedConsoleSink({
    endpoint: "https://console.example.test",
    authToken: "t",
    fetchImpl: fakeFetch
  });
  await sink.emit(fakeProjection("r"));
  await sink.emit(fakeProjection("r"));
  assert.deepEqual(keys, ["r:0", "r:1"]);
});

test("HostedConsoleSink uses a verbatim URL that already ends in /ingest/flow", async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push(url);
    return { ok: true, status: 202, statusText: "Accepted" };
  };
  const sink = new HostedConsoleSink({
    endpoint: "https://console.example.test/ingest/flow",
    authToken: "t",
    fetchImpl: fakeFetch
  });
  await sink.emit(fakeProjection());
  assert.equal(calls[0], "https://console.example.test/ingest/flow");
});

test("HostedConsoleSink rejects on a non-OK ingest response", async () => {
  const fakeFetch = async () => ({ ok: false, status: 500, statusText: "Server Error" });
  const sink = new HostedConsoleSink({ endpoint: "https://console.example.test", authToken: "t", fetchImpl: fakeFetch });
  await assert.rejects(() => sink.emit(fakeProjection()), /rejected projection: 500/);
});

test("HostedConsoleSink requires an endpoint (OFF by default)", () => {
  assert.throws(() => new HostedConsoleSink({ endpoint: "" }), /requires a configured `endpoint`/);
});

test("createConsoleSink hosted mode without a token falls back to FileConsoleSink (disabled)", () => {
  const sink = createConsoleSink({ mode: "hosted", hosted: { endpoint: "https://console.example.test" } });
  assert.equal(sink.kind, "file", "absent bearer token disables the hosted sink");
});

test("createConsoleSink builds the hosted sink when both URL and token are present", () => {
  const sink = createConsoleSink({
    mode: "hosted",
    hosted: { endpoint: "https://console.example.test", authToken: "t" }
  });
  assert.equal(sink.kind, "hosted");
});

test("the @kontourai/flow/console-contract subpath re-exports the sink + projector", async () => {
  const contract = await import("../../dist/console/console-contract.js");
  assert.equal(typeof contract.FileConsoleSink, "function");
  assert.equal(typeof contract.HostedConsoleSink, "function");
  assert.equal(typeof contract.createConsoleSink, "function");
  assert.equal(typeof contract.projectFlowRun, "function");
});
