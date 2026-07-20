/**
 * Node test: SSE /api/stream endpoint emits a "projection" event on file change.
 */
import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import http from "node:http";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { startFlowConsoleServer } from "../../dist/console/console-server.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fixtureSourceDir = path.join(root, "examples", "scenarios", "console-projection", "runtime-fixture", "console-projection-fixture");
const fixtureCwd = await mkdtemp(path.join(tmpdir(), "flow-sse-fixture-"));
const fixtureRunId = "console-projection-fixture";
const fixtureRunDir = path.join(fixtureCwd, ".kontourai", "flow", "runs", fixtureRunId);
const stateFile = path.join(fixtureRunDir, "state.json");
await mkdir(path.dirname(fixtureRunDir), { recursive: true });
await cp(fixtureSourceDir, fixtureRunDir, { recursive: true });

// Helper: listen to SSE stream and collect named events until n events or timeout
function collectSseEvents(baseUrl, eventName, maxCount, timeoutMs) {
  return new Promise((resolve, reject) => {
    const url = new URL("/api/stream", baseUrl);
    const collected = [];
    const timer = setTimeout(() => {
      req.destroy();
      resolve(collected);
    }, timeoutMs);

    const req = http.get(url.toString(), (res) => {
      let buf = "";
      res.on("data", (chunk) => {
        buf += chunk.toString();
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        let currentEvent = null;
        let currentData = null;
        for (const line of lines) {
          if (line.startsWith("event: ")) {
            currentEvent = line.slice("event: ".length).trim();
          } else if (line.startsWith("data: ")) {
            currentData = line.slice("data: ".length).trim();
          } else if (line === "" && currentEvent && currentData) {
            if (currentEvent === eventName) {
              collected.push(JSON.parse(currentData));
              if (collected.length >= maxCount) {
                clearTimeout(timer);
                req.destroy();
                resolve(collected);
                return;
              }
            }
            currentEvent = null;
            currentData = null;
          }
        }
      });
      res.once("error", reject);
    });
    req.once("error", (err) => {
      // ignore ECONNRESET from our own req.destroy()
      if (err.code === "ECONNRESET") { resolve(collected); return; }
      reject(err);
    });
  });
}

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out waiting for condition");
}

test("SSE /api/stream emits projection event when run state file changes", async () => {
  const server = await startFlowConsoleServer({
    runId: fixtureRunId,
    cwd: fixtureCwd,
    host: "127.0.0.1",
    port: 0,
  });

  const originalState = await readFile(stateFile, "utf8");

  try {
    // Start collecting SSE events BEFORE mutating the file
    const eventsPromise = collectSseEvents(server.url, "projection", 1, 5000);

    // Small pause so the SSE connection is established before we mutate
    await new Promise((r) => setTimeout(r, 200));

    // Mutate the state file — change next_action to trigger a projection diff
    const state = JSON.parse(originalState);
    state.next_action = "SSE test mutation — " + Date.now();
    await writeFile(stateFile, JSON.stringify(state, null, 2));

    const events = await eventsPromise;

    assert.ok(events.length >= 1, `expected at least 1 SSE projection event, got ${events.length}`);
    const payload = events[0];
    assert.equal(typeof payload, "object", "payload should be an object");
    assert.equal(payload.run.run_id, fixtureRunId, "projection run_id should match");
    assert.equal(payload.run.next_action ?? payload.next_action, state.next_action, "projection should reflect the mutated next_action");
  } finally {
    // Restore original state
    await writeFile(stateFile, originalState);
    await server.close();
  }
});

test("SSE /api/stream responds with correct content-type and initial comment", async () => {
  const server = await startFlowConsoleServer({
    runId: fixtureRunId,
    cwd: fixtureCwd,
    host: "127.0.0.1",
    port: 0,
  });

  try {
    await new Promise((resolve, reject) => {
      const url = new URL("/api/stream", server.url);
      const req = http.get(url.toString(), (res) => {
        assert.equal(res.statusCode, 200);
        assert.match(res.headers["content-type"] ?? "", /text\/event-stream/);

        let received = "";
        res.on("data", (chunk) => {
          received += chunk.toString();
          if (received.includes(": connected")) {
            req.destroy();
            resolve(undefined);
          }
        });
        res.once("error", reject);
      });
      req.once("error", (err) => {
        if (err.code === "ECONNRESET") { resolve(undefined); return; }
        reject(err);
      });
      setTimeout(() => reject(new Error("timeout waiting for SSE initial comment")), 3000);
    });
  } finally {
    await server.close();
  }
});

test("console server close drains an in-flight watcher repair before fixture cleanup", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "flow-sse-close-fixture-"));
  const runDir = path.join(cwd, ".kontourai", "flow", "runs", fixtureRunId);
  const statePath = path.join(runDir, "state.json");
  await mkdir(path.dirname(runDir), { recursive: true });
  await cp(fixtureSourceDir, runDir, { recursive: true });
  const server = await startFlowConsoleServer({ runId: fixtureRunId, cwd, host: "127.0.0.1", port: 0 });
  const lockRoot = path.join(runDir, ".mutation.lock");
  const blocker = path.join(lockRoot, "ticket-0000000000000-close-regression");
  const pendingBlocker = path.join(runDir, ".close-regression-blocker");

  try {
    await mkdir(pendingBlocker);
    await writeFile(path.join(pendingBlocker, "owner.json"), `${JSON.stringify({
      token: "close-regression",
      pid: 1,
      host: "close-regression.invalid",
      status: "holding",
      created_at: new Date().toISOString(),
    })}\n`);
    await rename(pendingBlocker, blocker);

    const state = JSON.parse(await readFile(statePath, "utf8"));
    state.next_action = `close regression ${Date.now()}`;
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
    await waitFor(async () => (await readdir(lockRoot)).filter((entry) => /^ticket-\d/.test(entry)).length > 1);

    let closed = false;
    const closePromise = server.close().then(() => { closed = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(closed, false, "close must wait for the watcher mutation already in flight");
    await rm(blocker, { recursive: true });
    await closePromise;
    await rm(cwd, { recursive: true });
  } finally {
    await rm(pendingBlocker, { recursive: true, force: true });
    await rm(blocker, { recursive: true, force: true });
    await server.close().catch(() => undefined);
    await rm(cwd, { recursive: true, force: true });
  }
});
