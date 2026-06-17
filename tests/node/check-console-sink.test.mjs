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
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  FileConsoleSink,
  HostedConsoleSink,
  createConsoleSink
} from "../../dist/console/console-sink.js";

function fakeProjection(runId = "sink-run") {
  return {
    schema_version: "1",
    run: {
      run_id: runId,
      definition_id: "demo",
      definition_version: "1",
      subject: null,
      status: "active",
      current_step: "verify",
      updated_at: "2026-06-16T00:00:00.000Z",
      params: {}
    },
    definition: { id: "demo", version: "1", title: null },
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

test("FileConsoleSink writes the projection under the run dir (default sink)", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "flow-sink-"));
  const sink = new FileConsoleSink({ cwd });
  assert.equal(sink.kind, "file");

  const projection = fakeProjection();
  await sink.emit(projection);

  const written = JSON.parse(
    await readFile(path.join(cwd, ".flow", "runs", "sink-run", "console-projection.json"), "utf8")
  );
  assert.deepEqual(written, projection, "the exact Flow-owned payload is written, unwrapped");
});

test("createConsoleSink defaults to the file sink (hosted is never default)", () => {
  const sink = createConsoleSink();
  assert.equal(sink.kind, "file");
});

test("createConsoleSink requires an endpoint when mode is hosted", () => {
  assert.throws(() => createConsoleSink({ mode: "hosted" }), /requires `hosted.endpoint`/);
});

test("HostedConsoleSink POSTs the SAME payload to the configured endpoint", async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 202, statusText: "Accepted" };
  };

  const sink = new HostedConsoleSink({
    endpoint: "https://console.example.test/ingest",
    authToken: "secret-token",
    headers: { "x-tenant": "acme" },
    fetchImpl: fakeFetch
  });
  assert.equal(sink.kind, "hosted");

  const projection = fakeProjection("hosted-run");
  await sink.emit(projection);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://console.example.test/ingest");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["content-type"], "application/json");
  assert.equal(calls[0].init.headers.authorization, "Bearer secret-token");
  assert.equal(calls[0].init.headers["x-tenant"], "acme");
  // The body is the EXACT Flow-owned projection — Flow does not wrap it in any
  // console envelope (the console does that on ingest).
  assert.deepEqual(JSON.parse(calls[0].init.body), projection);
});

test("HostedConsoleSink rejects on a non-OK ingest response", async () => {
  const fakeFetch = async () => ({ ok: false, status: 500, statusText: "Server Error" });
  const sink = new HostedConsoleSink({ endpoint: "https://console.example.test/ingest", fetchImpl: fakeFetch });
  await assert.rejects(() => sink.emit(fakeProjection()), /rejected projection: 500/);
});

test("HostedConsoleSink requires an endpoint (OFF by default)", () => {
  assert.throws(() => new HostedConsoleSink({ endpoint: "" }), /requires a configured `endpoint`/);
});

test("the @kontourai/flow/console-contract subpath re-exports the sink + projector", async () => {
  const contract = await import("../../dist/console/console-contract.js");
  assert.equal(typeof contract.FileConsoleSink, "function");
  assert.equal(typeof contract.HostedConsoleSink, "function");
  assert.equal(typeof contract.createConsoleSink, "function");
  assert.equal(typeof contract.projectFlowRun, "function");
});
