/**
 * flow#205 — evidence integrity re-verification.
 *
 * Flow records a SHA-256 for every attached artifact at attach time but, prior
 * to this fix, never re-verified it. docs/evidence.md step 6 and the
 * `integrity_mismatch` reason code promised a check that did not exist. These
 * tests prove the copied artifact is re-hashed at gate evaluation time and that
 * a tampered or missing file fails closed with the documented diagnostic.
 *
 * Fault-injection discipline: the tamper test modifies the COPIED artifact
 * bytes under the run directory (not the original source) and re-evaluates.
 * The matching no-tamper test guards against false positives from path or
 * encoding handling.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

import { startRun, loadRun, evaluateRun, attachEvidence } from "../../dist/index.js";

const NOW = "2026-08-04T00:00:00.000Z";

// A single gated step: verify-gate requires an "approval" trust.bundle claim.
// After the gate passes, current_step stays on "verify" (single step, next:
// null) and the run completes, so the gate can be re-evaluated explicitly via
// the `gate` option to observe the post-tamper outcome.
function definition() {
  return {
    id: "integrity-flow",
    version: "1",
    steps: [{ id: "verify", next: null }],
    gates: {
      "verify-gate": {
        step: "verify",
        on_route_back: { missing_evidence: "verify" },
        expects: [
          {
            id: "approval",
            kind: "trust.bundle",
            required: true,
            description: "Approval is present.",
            bundle_claim: {
              claimType: "approval",
              subjectType: "flow-step",
              subjectId: "verify",
              accepted_statuses: ["verified"]
            }
          }
        ]
      }
    }
  };
}

function approvalBundle() {
  return {
    schemaVersion: 5,
    source: "approver",
    claims: [
      {
        id: "claim.approval",
        subjectType: "flow-step",
        subjectId: "verify",
        facet: "process.approval",
        claimType: "approval",
        fieldOrBehavior: "approval",
        value: true,
        createdAt: NOW,
        updatedAt: NOW
      }
    ],
    evidence: [
      {
        id: "evidence.approval",
        claimId: "claim.approval",
        evidenceType: "human_attestation",
        method: "attestation",
        sourceRef: "approver",
        excerptOrSummary: "approved",
        observedAt: NOW,
        collectedBy: "approver"
      }
    ],
    policies: [],
    events: [
      {
        id: "event.approval.verified",
        claimId: "claim.approval",
        status: "verified",
        actor: "approver",
        method: "attestation",
        evidenceIds: ["evidence.approval"],
        createdAt: NOW,
        verifiedAt: NOW
      }
    ]
  };
}

async function makeRun(cwd) {
  await mkdir(cwd, { recursive: true });
  await writeFile(path.join(cwd, "flow.json"), JSON.stringify(definition()));
  const { runId } = await startRun("flow.json", { cwd, runId: "integrity-run" });
  return runId;
}

async function attachApproval(cwd, runId) {
  const bundlePath = path.join(cwd, "approval.json");
  await writeFile(bundlePath, JSON.stringify(approvalBundle(), null, 2));
  return attachEvidence(runId, { cwd, gate: "verify-gate", file: bundlePath, kind: "trust.bundle", bundle: true });
}

function integrityReasons(outcome) {
  return (outcome.diagnostics?.claim_evaluation ?? []).map((d) => d.reason);
}

test("fault injection: tampered copied artifact fails the gate with integrity_mismatch", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "flow-integrity-tamper-"));
  const runId = await makeRun(cwd);
  await attachApproval(cwd, runId);

  // Baseline: the gate passes while the copied artifact is intact.
  const before = await evaluateRun(runId, { cwd, now: NOW });
  assert.equal(before.outcomes[0].status, "pass", "gate passes before tampering");

  // Fault injection: modify the COPIED artifact bytes under the run directory.
  const run = await loadRun(runId, cwd);
  const entry = run.manifest.evidence.find((e) => e.gate_id === "verify-gate");
  const copiedPath = path.join(run.dir, entry.stored_path);
  const original = await readFile(copiedPath, "utf8");
  await writeFile(copiedPath, JSON.stringify({ ...JSON.parse(original), tampered: true }, null, 2));

  // Re-evaluate the same gate; the copied artifact no longer matches its
  // recorded sha256, so the gate must fail with the documented reason.
  const after = await evaluateRun(runId, { cwd, gate: "verify-gate", now: NOW });
  const outcome = after.outcomes[0];
  assert.notEqual(outcome.status, "pass", "gate must not pass after the copied artifact is tampered");
  const reasons = integrityReasons(outcome);
  assert.ok(
    reasons.includes("integrity_mismatch"),
    `expected integrity_mismatch diagnostic, got: ${JSON.stringify(outcome.diagnostics ?? {})}`
  );

  // Sanity: the recorded digest in the manifest still describes the ORIGINAL
  // bytes, proving the mismatch is a real recomputation, not a relabeling.
  const recorded = entry.sha256;
  const tamperedDigest = createHash("sha256").update(await readFile(copiedPath)).digest("hex");
  assert.notEqual(recorded, tamperedDigest, "tampered digest must differ from the recorded digest");
});

test("missing copied artifact also fails closed with integrity_mismatch", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "flow-integrity-missing-"));
  const runId = await makeRun(cwd);
  await attachApproval(cwd, runId);

  const before = await evaluateRun(runId, { cwd, now: NOW });
  assert.equal(before.outcomes[0].status, "pass", "gate passes before the artifact is removed");

  const run = await loadRun(runId, cwd);
  const entry = run.manifest.evidence.find((e) => e.gate_id === "verify-gate");
  const copiedPath = path.join(run.dir, entry.stored_path);
  await rm(copiedPath);

  const after = await evaluateRun(runId, { cwd, gate: "verify-gate", now: NOW });
  const outcome = after.outcomes[0];
  assert.notEqual(outcome.status, "pass", "gate must not pass when the copied artifact is missing");
  const reasons = integrityReasons(outcome);
  assert.ok(
    reasons.includes("integrity_mismatch"),
    `expected integrity_mismatch diagnostic for missing artifact, got: ${JSON.stringify(outcome.diagnostics ?? {})}`
  );
});

test("untouched artifact keeps the gate green (no false positives from path/encoding)", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "flow-integrity-clean-"));
  const runId = await makeRun(cwd);
  await attachApproval(cwd, runId);

  const first = await evaluateRun(runId, { cwd, now: NOW });
  assert.equal(first.outcomes[0].status, "pass", "gate passes on first evaluation");

  // Re-evaluate the same gate without touching any file. The re-hash must
  // match the recorded digest, so the gate stays green.
  const second = await evaluateRun(runId, { cwd, gate: "verify-gate", now: NOW });
  assert.equal(second.outcomes[0].status, "pass", "gate stays green on re-evaluation of an untouched artifact");
  assert.deepEqual(integrityReasons(second.outcomes[0]), [], "no diagnostics for a verified artifact");
});
