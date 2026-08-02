/**
 * flow#201 — run artifacts are published atomically.
 *
 * `saveRun` used to publish `state.json`, the evidence manifest, and both
 * report projections with truncate-then-write. A reader that is not holding the
 * run mutation ticket — `flow status`, the console watcher, a downstream
 * consumer — could therefore observe an empty or half-written canonical record,
 * and a crash mid-write left one behind permanently.
 *
 * The known-bad fixture is the concurrent reader below: on pre-fix code it
 * observes unparseable `state.json` snapshots within a few dozen mutations.
 */
import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, readdir, stat, chmod, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import * as flow from "../../dist/index.js";

const definitionPath = new URL("../../examples/agent-dev-flow.json", import.meta.url).pathname;

function planBundle(index) {
  return {
    schemaVersion: 5,
    source: `atomic-publication/${index}`,
    claims: [{
      id: `claim.builder.acceptance.${index}`,
      subjectType: "flow-step",
      subjectId: "builder.plan",
      facet: "process",
      claimType: "builder.acceptance",
      fieldOrBehavior: "acceptanceCriteria",
      value: true,
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:00.000Z"
    }],
    // A payload large enough that a truncate-then-write publication spans more
    // than one write(2), which is what makes the torn window observable.
    evidence: [{
      id: `evidence.${index}`,
      claimId: `claim.builder.acceptance.${index}`,
      evidenceType: "attestation",
      method: "attestation",
      sourceRef: `atomic-publication:${index}`,
      excerptOrSummary: "x".repeat(4000),
      observedAt: "2026-07-10T00:00:00.000Z",
      collectedBy: "test"
    }],
    events: [{
      id: `event.${index}`,
      claimId: `claim.builder.acceptance.${index}`,
      status: "verified",
      type: "verification",
      actor: "test",
      method: "attestation",
      evidenceIds: [`evidence.${index}`],
      createdAt: "2026-07-10T00:00:00.000Z",
      verifiedAt: "2026-07-10T00:00:00.000Z"
    }],
    policies: []
  };
}

async function attachRounds(runId, cwd, source, rounds) {
  const entries = [];
  for (let index = 0; index < rounds; index += 1) {
    await writeFile(source, `${JSON.stringify(planBundle(index))}\n`);
    entries.push(await flow.attachEvidence(runId, {
      cwd,
      gate: "plan-gate",
      file: source,
      kind: "trust.bundle",
      bundle: true
    }));
  }
  return entries;
}

test("a concurrent reader never observes a partial run artifact", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "flow-atomic-publication-"));
  const started = await flow.startRun(definitionPath, { cwd, runId: "atomic-publication" });
  const source = path.join(cwd, "bundle.json");
  const watched = [
    path.join(started.dir, "state.json"),
    path.join(started.dir, "evidence", "manifest.json"),
    path.join(started.dir, "report.json")
  ];

  let reading = true;
  const partial = [];
  let reads = 0;
  const reader = (async () => {
    while (reading) {
      for (const file of watched) {
        reads += 1;
        try {
          JSON.parse(await readFile(file, "utf8"));
        } catch (error) {
          // ENOENT would mean the canonical name vanished, which is also a
          // publication defect; record every non-atomic observation.
          partial.push(`${path.basename(file)}: ${error.message}`);
        }
      }
    }
  })();

  try {
    await attachRounds("atomic-publication", cwd, source, 60);
  } finally {
    reading = false;
    await reader;
  }

  assert.ok(reads > 1000, `the reader must actually race the writer (observed ${reads} reads)`);
  assert.deepEqual(partial, [], "no reader may observe a partial or missing run artifact");
});

// Guards the atomic publication's OWN hazards, not the original defect: this
// one passes against pre-fix code, because truncate-in-place trivially leaves
// no temp file and keeps the mode. It is here so a future change to the
// staging path cannot start leaking temps or narrowing run-file permissions.
test("publishing a run artifact leaves no temp file and preserves the prior mode", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "flow-atomic-residue-"));
  const started = await flow.startRun(definitionPath, { cwd, runId: "atomic-residue" });
  const statePath = path.join(started.dir, "state.json");
  await chmod(statePath, 0o640);

  await attachRounds("atomic-residue", cwd, path.join(cwd, "bundle.json"), 3);

  const residue = (await readdir(started.dir)).filter((entry) => entry.endsWith(".tmp"));
  assert.deepEqual(residue, [], "an atomic publication must not leave temp artifacts behind");
  assert.equal((await stat(statePath)).mode & 0o777, 0o640, "publication must not narrow who can read a run");
  assert.equal((await lstat(statePath)).isSymbolicLink(), false);
});

// Also passes against pre-fix code, and deliberately so. The original #201
// report described concurrent writers clobbering each other and minting
// colliding evidence ids; on this codebase `withRunMutationLock` serialises
// run mutations across processes and the trust-attachment reducer already
// rejects a duplicate evidence id outright. This test pins those two
// properties so they cannot silently regress — it is not a probe for the
// torn-publication defect above.
test("concurrent evaluations of one run neither lose an outcome nor collide on an evidence id", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "flow-atomic-concurrent-"));
  await flow.startRun(definitionPath, { cwd, runId: "atomic-concurrent" });

  const sources = await Promise.all([0, 1, 2, 3].map(async (index) => {
    const file = path.join(cwd, `bundle-${index}.json`);
    await writeFile(file, `${JSON.stringify(planBundle(index))}\n`);
    return file;
  }));

  // Four writers racing the same run. Each must either succeed with a distinct
  // evidence id or fail loudly; none may silently overwrite another's record.
  const settled = await Promise.allSettled(sources.map((file) => flow.attachEvidence("atomic-concurrent", {
    cwd,
    gate: "plan-gate",
    file,
    kind: "trust.bundle",
    bundle: true
  })));
  const attached = settled.filter((entry) => entry.status === "fulfilled").map((entry) => entry.value);
  assert.equal(attached.length, settled.length, `every attach must succeed or report why: ${settled.map((entry) => entry.reason?.message).filter(Boolean).join("; ")}`);

  const ids = attached.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length, "concurrent attaches must not mint colliding evidence ids");

  const run = await flow.loadRun("atomic-concurrent", cwd);
  const recorded = run.manifest.evidence.map((entry) => entry.id);
  for (const id of ids) {
    assert.ok(recorded.includes(id), `evidence ${id} was reported to its caller but is absent from the manifest of record`);
  }
});
