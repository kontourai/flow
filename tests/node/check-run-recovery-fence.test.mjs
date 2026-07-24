import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  access,
  chmod,
  constants,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  FLOW_RUN_RECOVERY_FENCE_PROTOCOL,
  FileConsoleSink,
  assertRunRecoveryFenceOpen,
  finalizeRunRecoveryFence,
  flowRunRecoveryFencePath,
  inspectRunRecoveryFence,
  listRunsWithDiagnostics,
  loadRun,
  pauseRun,
  projectFlowRunFromFiles,
  startRun,
  startFlowConsoleServer,
  withRunMutationLock,
  withRunRecoveryLock,
  withRunRecoveryFenceRead,
  writeRunRecoveryFence
} from "../../dist/index.js";
import { projectFlowRunFromResolvedRun } from "../../dist/console/console-projection.js";
import { readConsoleArtifact } from "../../dist/console/console-server.js";
import { cliPath, execFile } from "./helpers/cli.mjs";

const definitionPath = new URL("../../examples/agent-dev-flow.json", import.meta.url).pathname;
const runtimeUrl = new URL("../../dist/index.js", import.meta.url).href;

async function fixture(runId = "recovery-fence") {
  const cwd = await mkdtemp(path.join(tmpdir(), "flow-recovery-fence-"));
  const run = await startRun(definitionPath, { cwd, runId });
  return { cwd, run };
}

function fence(runId, status, recoveryId = "recovery-1") {
  return {
    protocol: FLOW_RUN_RECOVERY_FENCE_PROTOCOL,
    run_id: runId,
    recovery_id: recoveryId,
    status,
    updated_at: "2026-07-23T12:00:00.000Z"
  };
}

async function activateAndFinalize(runId, recoveryId, cwd, updatedAt = "2026-07-23T12:01:00.000Z") {
  const active = await writeRunRecoveryFence(runId, fence(runId, "active", recoveryId), cwd);
  return finalizeRunRecoveryFence(runId, {
    recovery_id: recoveryId,
    expected_generation: active.fence.generation,
    updated_at: updatedAt
  }, cwd);
}

async function waitForFile(file) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      await access(file);
      return;
    } catch {
      await delay(10);
    }
  }
  throw new Error(`timed out waiting for ${file}`);
}

test("recovery fence absence and a stable open record allow supported reads", async () => {
  const { cwd, run } = await fixture();
  const absent = await inspectRunRecoveryFence(run.runId, cwd);
  assert.equal(absent.status, "absent");
  assert.match(absent.directory.inode, /^\d+$/);
  await assert.doesNotReject(() => loadRun(run.runId, cwd));

  const active = await writeRunRecoveryFence(run.runId, fence(run.runId, "active"), cwd);
  await finalizeRunRecoveryFence(run.runId, {
    recovery_id: "recovery-1",
    expected_generation: active.fence.generation,
    updated_at: "2026-07-23T12:01:00.000Z"
  }, cwd);
  const inspected = await inspectRunRecoveryFence(run.runId, cwd);
  assert.equal(inspected.status, "open");
  assert.deepEqual(
    { ...inspected.fence, generation: undefined },
    {
      ...fence(run.runId, "open"),
      updated_at: "2026-07-23T12:01:00.000Z",
      generation: undefined,
      previous_generation: active.fence.generation
    }
  );
  assert.match(
    inspected.fence.generation,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
  );
  assert.match(inspected.directory.device, /^\d+$/);
  assert.match(inspected.directory.inode, /^\d+$/);
  await assert.doesNotReject(() => assertRunRecoveryFenceOpen(run.runId, cwd));
  await assert.doesNotReject(() => loadRun(run.runId, cwd));
  await assert.rejects(
    () => writeRunRecoveryFence(
      run.runId,
      { ...fence(run.runId, "active"), generation: "caller-chosen" },
      cwd
    ),
    /flow\.run_recovery\.malformed/
  );
});

test("recovery fence inspection rejects oversized and writable records before parsing", async () => {
  const oversizedFixture = await fixture("oversized-fence");
  const oversizedPath = flowRunRecoveryFencePath(oversizedFixture.run.runId, oversizedFixture.cwd);
  await writeFile(oversizedPath, Buffer.alloc(65_537, 0x20), { mode: 0o600 });
  await assert.rejects(
    () => inspectRunRecoveryFence(oversizedFixture.run.runId, oversizedFixture.cwd),
    /flow\.run_recovery\.malformed/
  );

  const writableFixture = await fixture("writable-fence");
  const writablePath = flowRunRecoveryFencePath(writableFixture.run.runId, writableFixture.cwd);
  await writeRunRecoveryFence(
    writableFixture.run.runId,
    fence(writableFixture.run.runId, "active"),
    writableFixture.cwd
  );
  await chmod(writablePath, 0o622);
  await assert.rejects(
    () => inspectRunRecoveryFence(writableFixture.run.runId, writableFixture.cwd),
    /flow\.run_recovery\.malformed/
  );
});

test("active, malformed, and unknown recovery fence states fail closed", async () => {
  const { cwd, run } = await fixture("closed-fence");
  const file = flowRunRecoveryFencePath(run.runId, cwd);

  await writeRunRecoveryFence(run.runId, fence(run.runId, "active"), cwd);
  await assert.rejects(() => loadRun(run.runId, cwd), /flow\.run_recovery\.active/);

  await writeFile(file, "{broken\n");
  await assert.rejects(() => loadRun(run.runId, cwd), /flow\.run_recovery\.malformed/);

  await writeFile(file, `${JSON.stringify({ ...fence(run.runId, "open"), status: "future" })}\n`);
  await assert.rejects(() => loadRun(run.runId, cwd), /flow\.run_recovery\.unknown/);

  await writeFile(file, `${JSON.stringify({ ...fence(run.runId, "open"), updated_at: "tomorrow" })}\n`);
  await assert.rejects(() => loadRun(run.runId, cwd), /flow\.run_recovery\.malformed/);

  await writeFile(file, `${JSON.stringify({ ...fence(run.runId, "open"), provider: "specific" })}\n`);
  await assert.rejects(() => loadRun(run.runId, cwd), /flow\.run_recovery\.malformed/);

  await writeFile(file, `${JSON.stringify({
    ...fence(run.runId, "active"),
    generation: "not-a-uuid"
  })}\n`);
  await assert.rejects(() => loadRun(run.runId, cwd), /flow\.run_recovery\.malformed/);
});

test("a supported read rejects a fence generation changed during the read", async () => {
  const { cwd, run } = await fixture("read-toctou");
  await activateAndFinalize(run.runId, "recovery-1", cwd);

  await assert.rejects(
    () => withRunRecoveryFenceRead(run.runId, cwd, async () => {
      await activateAndFinalize(run.runId, "recovery-2", cwd);
      return "stale";
    }),
    /flow\.run_recovery\.changed/
  );
});

test("a supported read surfaces an active fence when its callback fences and throws", async () => {
  const { cwd, run } = await fixture("read-throw-active");
  await activateAndFinalize(run.runId, "recovery-open", cwd);
  const sentinel = new Error("callback sentinel must not mask a changed fence");

  await assert.rejects(
    () => withRunRecoveryFenceRead(run.runId, cwd, async () => {
      await writeRunRecoveryFence(
        run.runId,
        fence(run.runId, "active", "recovery-active"),
        cwd
      );
      throw sentinel;
    }),
    (error) => {
      assert.equal(error.code, "flow.run_recovery.active");
      assert.notEqual(error, sentinel);
      return true;
    }
  );
});

test("a supported read preserves its callback error when the fence stays stable", async () => {
  const { cwd, run } = await fixture("read-throw-stable");
  await activateAndFinalize(run.runId, "recovery-open", cwd);
  const sentinel = new Error("stable callback sentinel");

  await assert.rejects(
    () => withRunRecoveryFenceRead(run.runId, cwd, async () => {
      throw sentinel;
    }),
    (error) => {
      assert.equal(error, sentinel);
      return true;
    }
  );
});

test("Flow-generated generations reject open A to active B to open A byte reuse", async () => {
  const { cwd, run } = await fixture("read-aba");
  const first = await activateAndFinalize(run.runId, "recovery-a", cwd);

  await assert.rejects(
    () => withRunRecoveryFenceRead(run.runId, cwd, async () => {
      await writeRunRecoveryFence(run.runId, fence(run.runId, "active", "recovery-b"), cwd);
      const active = await inspectRunRecoveryFence(run.runId, cwd);
      await finalizeRunRecoveryFence(run.runId, {
        recovery_id: "recovery-b",
        expected_generation: active.fence.generation,
        updated_at: "2026-07-23T12:01:00.000Z"
      }, cwd);
    }),
    /flow\.run_recovery\.changed/
  );
  const last = await inspectRunRecoveryFence(run.runId, cwd);
  assert.notEqual(last.fence.generation, first.fence.generation);
});

test("supported reads reject a byte-identical replacement of the fixed run directory", async () => {
  const { cwd, run } = await fixture("read-dir-replacement");
  const parked = `${run.dir}.parked`;
  try {
    await assert.rejects(
      () => withRunRecoveryFenceRead(run.runId, cwd, async () => {
        await rename(run.dir, parked);
        await cp(parked, run.dir, { recursive: true, preserveTimestamps: true });
      }),
      /flow\.run_recovery\.changed/
    );
  } finally {
    await rm(parked, { recursive: true, force: true });
  }
});

test("a mutation queued before fencing requeues until that exact recovery opens", async () => {
  const { cwd, run } = await fixture("mutation-recheck");
  let releaseFirst;
  const firstHolding = new Promise((resolve) => { releaseFirst = resolve; });
  let firstAcquired;
  const acquired = new Promise((resolve) => { firstAcquired = resolve; });

  const first = withRunMutationLock(run.runId, cwd, async () => {
    firstAcquired();
    await firstHolding;
  });
  await acquired;

  let secondRan = false;
  const second = withRunMutationLock(run.runId, cwd, async () => {
    secondRan = true;
  });
  const lockRoot = path.join(run.dir, ".mutation.lock");
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const tickets = await readdir(lockRoot);
    if (tickets.filter((name) => name.startsWith("ticket-")).length === 2) break;
    if (attempt === 199) assert.fail("second mutation did not queue before recovery fencing");
    await delay(5);
  }
  const active = await writeRunRecoveryFence(run.runId, fence(run.runId, "active"), cwd);
  // The earlier ordinary holder may remain active beyond the native five-second
  // contention timeout after fencing. The already-queued mutation must observe
  // the fence while it waits rather than being discarded before acquisition.
  await delay(5_250);
  releaseFirst();
  await first;

  assert.equal(secondRan, false);

  let recoveryRan = false;
  await withRunRecoveryLock(run.runId, "recovery-1", cwd, async () => {
    recoveryRan = true;
    await delay(5_250);
  });
  assert.equal(recoveryRan, true);
  await finalizeRunRecoveryFence(run.runId, {
    recovery_id: "recovery-1",
    expected_generation: active.fence.generation,
    updated_at: "2026-07-23T12:01:00.000Z"
  }, cwd);
  const opened = await inspectRunRecoveryFence(run.runId, cwd);
  assert.equal(opened.status, "open");
  assert.equal(opened.fence.previous_generation, active.fence.generation);
  await second;
  assert.equal(secondRan, true);
  await assert.rejects(
    () => withRunRecoveryLock(run.runId, "wrong-recovery", cwd, async () => undefined),
    /flow\.run_recovery\.coordinator_fence_mismatch/
  );
});

test("a mutation callback cannot forge the private recovery retry signal", async () => {
  const { cwd, run } = await fixture("mutation-callback-error");
  let attempts = 0;
  const callbackError = Object.assign(new Error("caller recovery error"), {
    code: "flow.run_recovery.active"
  });
  await assert.rejects(
    () => withRunMutationLock(run.runId, cwd, async () => {
      attempts += 1;
      throw callbackError;
    }),
    (error) => error === callbackError
  );
  assert.equal(attempts, 1);
});

test("stale ticket cleanup cannot derive a removal path from persisted owner data", async () => {
  const { cwd, run } = await fixture("mutation-cleanup-path");
  await withRunMutationLock(run.runId, cwd, async () => undefined);
  const lockRoot = path.join(run.dir, ".mutation.lock");
  const victim = path.join(run.dir, "victim-empty");
  await mkdir(victim);
  const token = randomUUID();
  const ticket = path.join(lockRoot, `ticket-${Date.now().toString().padStart(13, "0")}-${token}`);
  await mkdir(ticket);
  await writeFile(path.join(ticket, "owner.json"), `${JSON.stringify({
    token: ["foreign", "..", "..", "victim-empty"].join(path.sep),
    pid: 1,
    host: "foreign.invalid",
    status: "released",
    created_at: "2026-07-23T12:00:00.000Z"
  })}\n`);

  await assert.rejects(
    () => withRunMutationLock(run.runId, cwd, async () => undefined),
    /flow\.run_mutation\.lock\.root_invalid/
  );
  await assert.doesNotReject(() => access(victim));
});

test("generic writes reject open and recovery lock rejects any active generation changed by its callback", async () => {
  const { cwd, run } = await fixture("recovery-postcondition");
  await writeRunRecoveryFence(run.runId, fence(run.runId, "active", "recovery-1"), cwd);

  await assert.rejects(
    () => withRunRecoveryLock(run.runId, "recovery-1", cwd, async () => {
      await writeRunRecoveryFence(run.runId, fence(run.runId, "open", "recovery-1"), cwd);
    }),
    /flow\.run_recovery\.open_requires_finalize/
  );

  await writeRunRecoveryFence(run.runId, fence(run.runId, "active", "recovery-1"), cwd);
  await assert.rejects(
    () => withRunRecoveryLock(run.runId, "recovery-1", cwd, async () => {
      await writeRunRecoveryFence(run.runId, fence(run.runId, "active", "recovery-1"), cwd);
    }),
    /flow\.run_recovery\.coordinator_fence_mismatch/
  );

  await writeRunRecoveryFence(run.runId, fence(run.runId, "active", "recovery-1"), cwd);
  await assert.rejects(
    () => withRunRecoveryLock(run.runId, "recovery-1", cwd, async () => {
      await writeRunRecoveryFence(run.runId, fence(run.runId, "active", "recovery-1"), cwd);
      throw new Error("callback failed after replacing the active generation");
    }),
    (error) => {
      assert.equal(error.code, "flow.run_recovery.coordinator_fence_mismatch");
      assert.doesNotMatch(error.message, /callback failed/);
      return true;
    }
  );

  await writeRunRecoveryFence(run.runId, fence(run.runId, "active", "recovery-1"), cwd);
  await assert.rejects(
    () => withRunRecoveryLock(run.runId, "recovery-1", cwd, async () => {
      throw new Error("stable callback failure");
    }),
    /stable callback failure/
  );
});

test("cross-process readers stay closed until a separate native-ticket finalizer publishes open", async () => {
  const { cwd, run } = await fixture("recovery-cross-process");
  const active = await writeRunRecoveryFence(
    run.runId,
    fence(run.runId, "active", "recovery-cross-process"),
    cwd
  );
  const entered = path.join(cwd, "recovery-entered");
  const release = path.join(cwd, "recovery-release");
  const recoveryScript = `
    import { access, writeFile } from "node:fs/promises";
    import { setTimeout as delay } from "node:timers/promises";
    import { loadRun, withRunRecoveryLock } from ${JSON.stringify(runtimeUrl)};
    const [cwd, runId, entered, release] = process.argv.slice(1);
    let readSucceeded = true;
    await withRunRecoveryLock(runId, "recovery-cross-process", cwd, async () => {
      await writeFile(entered, "entered");
      try { await loadRun(runId, cwd); } catch { readSucceeded = false; }
      for (;;) {
        try { await access(release); break; } catch { await delay(10); }
      }
    });
    process.stdout.write(JSON.stringify({ readSucceeded }));
  `;
  const recoveryProcess = execFile(
    process.execPath,
    ["--input-type=module", "-e", recoveryScript, cwd, run.runId, entered, release]
  );
  await waitForFile(entered);

  const directOpenScript = `
    import { FLOW_RUN_RECOVERY_FENCE_PROTOCOL, writeRunRecoveryFence } from ${JSON.stringify(runtimeUrl)};
    const [cwd, runId] = process.argv.slice(1);
    await writeRunRecoveryFence(runId, {
      protocol: FLOW_RUN_RECOVERY_FENCE_PROTOCOL,
      run_id: runId,
      recovery_id: "recovery-cross-process",
      status: "open",
      updated_at: "2026-07-23T12:01:00.000Z"
    }, cwd);
  `;
  await assert.rejects(
    () => execFile(process.execPath, [
      "--input-type=module",
      "-e",
      directOpenScript,
      cwd,
      run.runId
    ]),
    /flow\.run_recovery\.open_requires_finalize/
  );
  await assert.rejects(() => loadRun(run.runId, cwd), /flow\.run_recovery\.active/);

  await writeFile(release, "release");
  const recoveryResult = await recoveryProcess;
  assert.deepEqual(JSON.parse(recoveryResult.stdout), { readSucceeded: false });
  assert.equal((await inspectRunRecoveryFence(run.runId, cwd)).status, "active");

  const finalizeScript = `
    import { finalizeRunRecoveryFence } from ${JSON.stringify(runtimeUrl)};
    const [cwd, runId, generation] = process.argv.slice(1);
    const opened = await finalizeRunRecoveryFence(runId, {
      recovery_id: "recovery-cross-process",
      expected_generation: generation,
      updated_at: "2026-07-23T12:02:00.000Z"
    }, cwd);
    process.stdout.write(JSON.stringify({ status: opened.status }));
  `;
  const finalized = await execFile(process.execPath, [
    "--input-type=module",
    "-e",
    finalizeScript,
    cwd,
    run.runId,
    active.fence.generation
  ]);
  assert.deepEqual(JSON.parse(finalized.stdout), { status: "open" });
  await assert.doesNotReject(() => loadRun(run.runId, cwd));
});

test("durable fence publication exposes deterministic faults at every write step", async () => {
  const stages = [
    "afterTempWrite",
    "afterTempFsync",
    "afterRename",
    "afterParentFsync"
  ];
  for (const stage of stages) {
    const { cwd, run } = await fixture(`fence-fault-${stage}`);
    const before = await activateAndFinalize(run.runId, "before", cwd);
    await assert.rejects(
      () => writeRunRecoveryFence(
        run.runId,
        fence(run.runId, "active", "after"),
        cwd,
        { [stage]: () => { throw new Error(`fault:${stage}`); } }
      ),
      new RegExp(`fault:${stage}`)
    );
    const after = await inspectRunRecoveryFence(run.runId, cwd);
    if (stage === "afterTempWrite" || stage === "afterTempFsync") {
      assert.equal(after.fence.generation, before.fence.generation);
    } else {
      assert.equal(after.status, "active");
      assert.notEqual(after.fence.generation, before.fence.generation);
    }
    assert.deepEqual(
      (await readdir(run.dir)).filter((name) => name.includes("recovery-fence.json.") && name.endsWith(".tmp")),
      []
    );
  }
});

test("list diagnoses fenced runs and start never reclaims a fenced fixed run path", async () => {
  const { cwd, run } = await fixture("list-fence");
  await writeRunRecoveryFence(run.runId, fence(run.runId, "active"), cwd);

  const listed = await listRunsWithDiagnostics(cwd);
  assert.equal(listed.runs.some((entry) => entry.run_id === run.runId), false);
  assert.equal(listed.diagnostics.some((entry) =>
    entry.run_id === run.runId && entry.code === "flow.run_recovery.active"
  ), true);

  await assert.rejects(
    () => startRun(definitionPath, { cwd, runId: run.runId }),
    /flow\.run_location\.allocation_collision/
  );
  assert.equal(JSON.parse(await readFile(flowRunRecoveryFencePath(run.runId, cwd), "utf8")).status, "active");
});

test("Console projection and FileConsoleSink reject an active recovery fence", async () => {
  const { cwd, run } = await fixture("console-fence");
  const projection = await projectFlowRunFromFiles(run.runId, { cwd });
  const loaded = await loadRun(run.runId, cwd);
  await writeRunRecoveryFence(run.runId, fence(run.runId, "active"), cwd);

  await assert.rejects(
    () => projectFlowRunFromResolvedRun(loaded, { cwd }),
    /flow\.run_recovery\.active/
  );
  await assert.rejects(
    () => new FileConsoleSink({ cwd }).emit(projection, { resolvedRunDir: run.dir }),
    /flow\.run_recovery\.active/
  );
  await assert.rejects(
    access(path.join(run.dir, "console-projection.json"), constants.F_OK),
    /ENOENT/
  );
});

test("FileConsoleSink recomputes a stale projection under its mutation ticket", async () => {
  const { cwd, run } = await fixture("sink-stale-projection");
  const stale = await projectFlowRunFromFiles(run.runId, { cwd });
  await pauseRun(run.runId, {
    cwd,
    reason: "exercise stale projection",
    authority: {
      kind: "operator_request",
      actor: "operator:test",
      request_ref: "request:sink-stale",
      requested_at: "2026-07-23T12:00:00.000Z"
    }
  });

  await new FileConsoleSink({ cwd }).emit(stale, { resolvedRunDir: run.dir });
  const stored = JSON.parse(await readFile(path.join(run.dir, "console-projection.json"), "utf8"));
  assert.equal(stored.run.status, "paused");
});

test("CLI high-level reads fail closed on an active recovery fence", async () => {
  const { cwd, run } = await fixture("cli-fence");
  await writeRunRecoveryFence(run.runId, fence(run.runId, "active"), cwd);

  await assert.rejects(
    () => execFile(process.execPath, [cliPath, "status", run.runId, "--cwd", cwd]),
    (error) => {
      assert.match(error.stderr, /flow\.run_recovery\.active/);
      return true;
    }
  );
});

test("Console server projection and artifact reads close and reopen with the fence", async () => {
  const { cwd, run } = await fixture("console-server-fence");
  const server = await startFlowConsoleServer({
    runId: run.runId,
    cwd,
    host: "127.0.0.1",
    port: 0
  });
  try {
    await writeRunRecoveryFence(run.runId, fence(run.runId, "active"), cwd);
    const blockedProjection = await fetch(`${server.url}api/projection`);
    assert.equal(blockedProjection.status, 500);
    assert.match(await blockedProjection.text(), /flow\.run_recovery\.active/);
    const blockedArtifact = await fetch(`${server.url}artifacts/report.json`);
    assert.equal(blockedArtifact.status, 500);
    assert.match(await blockedArtifact.text(), /flow\.run_recovery\.active/);

    const active = await inspectRunRecoveryFence(run.runId, cwd);
    await finalizeRunRecoveryFence(run.runId, {
      recovery_id: "recovery-1",
      expected_generation: active.fence.generation,
      updated_at: "2026-07-23T12:01:00.000Z"
    }, cwd);
    const reopenedProjection = await fetch(`${server.url}api/projection`);
    assert.equal(reopenedProjection.status, 200);
    const reopenedArtifact = await fetch(`${server.url}artifacts/report.json`);
    assert.equal(reopenedArtifact.status, 200);
    assert.equal((await reopenedArtifact.json()).run_id, run.runId);
  } finally {
    await server.close();
  }
});

test("Console artifact reads do not follow a leaf swapped after validation", async () => {
  const { cwd, run } = await fixture("console-artifact-leaf-swap");
  const artifact = path.join(run.dir, "report.json");
  const parked = `${artifact}.parked`;
  const outside = path.join(cwd, "outside-secret.json");
  await writeFile(outside, '{"secret":true}\n', { mode: 0o600 });
  const pinnedRunRoot = await realpath(run.dir);
  try {
    const bytes = await readConsoleArtifact(
      run.dir,
      pinnedRunRoot,
      "report.json",
      {
      afterPathValidation: async () => {
        await rename(artifact, parked);
        await symlink(outside, artifact);
      }
      }
    );
    assert.equal(bytes, null);
  } finally {
    await rm(artifact, { force: true });
    await rename(parked, artifact);
  }
});
