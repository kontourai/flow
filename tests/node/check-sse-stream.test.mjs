/**
 * Node test: SSE /api/stream endpoint emits a "projection" event on file change.
 */
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { startFlowConsoleServer } from "../../dist/console/console-server.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fixtureCwd = path.join(root, "examples", "scenarios", "console-projection");
const fixtureRunId = "console-projection-fixture";
const stateFile = path.join(fixtureCwd, ".flow", "runs", fixtureRunId, "state.json");

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
