import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  applyFlowConfigMerge,
  FLOW_SCHEMA_VERSION,
  loadFlowConfig,
  previewFlowConfigMerge,
  previewFlowConfigMergeFile,
  renderConfigMergeMarkdown
} from "../../dist/index.js";
import { localConfigFixture, proposedConfigFixture, resourceConfigFixture } from "./helpers/config-fixtures.mjs";

test("config merge preview reports accepted, rejected, conflicts, unchanged without mutating inputs", () => {
  const local = localConfigFixture();
  const before = JSON.stringify(local);
  const report = previewFlowConfigMerge(local, proposedConfigFixture(), {
    localConfigPath: "/tmp/project/.flow/config.json",
    proposalPath: "/tmp/proposal.json"
  });

  assert.equal(JSON.stringify(local), before);
  assert.equal(report.mode, "preview");
  assert.equal(report.status, "conflicts");
  assert.ok(report.proposed_changes.length > 0);
  assert.ok(report.accepted_changes.some((change) => change.path === "$.trusted_producers.quality.lint.producers"));
  assert.ok(report.accepted_changes.some((change) => change.path === "$.gate_overrides.verify-gate.expectations.lint-passed.required"));
  assert.ok(report.unchanged.some((change) => change.path === "$.trusted_producers.quality.browser-evidence.producers"));
  assert.ok(report.conflicts.some((change) => change.path === "$.trusted_producers.quality.tests.producers"));
  assert.ok(report.rejected_changes.some((change) => change.path === "$.gate_overrides.verify-gate.expectations.tests-passed.required"));
  assert.deepEqual(report.merged_config.trusted_producers["quality.tests"].producers, ["ci/main"]);
  assert.equal(report.merged_config.gate_overrides["verify-gate"].expectations["tests-passed"].required, true);
  assert.deepEqual(Object.keys(report.summary), ["proposed", "accepted", "rejected", "conflicts", "unchanged", "exceptions"]);
});

test("Resource-shaped project config normalizes for load and merge workflows", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "flow-resource-config-"));
  await mkdir(path.join(cwd, ".flow"), { recursive: true });
  await writeFile(path.join(cwd, ".flow", "config.json"), `${JSON.stringify(resourceConfigFixture(localConfigFixture()), null, 2)}\n`);
  await writeFile(path.join(cwd, "proposal.json"), `${JSON.stringify(resourceConfigFixture(proposedConfigFixture()), null, 2)}\n`);

  const loaded = await loadFlowConfig(cwd);
  assert.equal(loaded.schema_version, FLOW_SCHEMA_VERSION);
  assert.equal(loaded.apiVersion, undefined);
  assert.deepEqual(loaded.trusted_producers["quality.tests"].producers, ["ci/main"]);

  const preview = await previewFlowConfigMergeFile("proposal.json", { cwd });
  assert.equal(preview.status, "conflicts");
  assert.deepEqual(preview.merged_config.trusted_producers["quality.tests"].producers, ["ci/main"]);
  assert.equal(preview.merged_config.apiVersion, undefined);

  const blocked = await applyFlowConfigMerge(cwd, "proposal.json");
  assert.equal(blocked.status, "blocked");
  let stored = JSON.parse(await readFile(path.join(cwd, ".flow", "config.json"), "utf8"));
  assert.equal(stored.kind, "FlowProjectConfig");

  const applied = await applyFlowConfigMerge(cwd, "proposal.json", {
    acceptConflicts: [
      "$.trusted_producers.quality.tests",
      "$.gate_overrides.verify-gate.expectations.tests-passed"
    ],
    exceptionReason: "accepted Resource-shaped project config proposal",
    authority: "flow-maintainer"
  });
  assert.equal(applied.status, "applied");
  stored = JSON.parse(await readFile(path.join(cwd, ".flow", "config.json"), "utf8"));
  assert.equal(stored.apiVersion, undefined);
  assert.deepEqual(stored.trusted_producers["quality.tests"].producers, ["ci/kit"]);
  assert.equal(stored.gate_overrides["verify-gate"].expectations["tests-passed"].required, false);
});

test("project config merge rejects unsafe map keys before object traversal", () => {
  assert.equal({}.polluted, undefined);
  assert.throws(
    () => previewFlowConfigMerge(localConfigFixture(), JSON.parse(`{
      "schema_version": "${FLOW_SCHEMA_VERSION}",
      "trusted_producers": {
        "__proto__": {
          "polluted": true
        }
      }
    }`)),
    /unsafe config path segment: __proto__/
  );
  assert.throws(
    () => previewFlowConfigMerge(localConfigFixture(), JSON.parse(`{
      "apiVersion": "flow.kontourai.io/v1alpha1",
      "kind": "FlowProjectConfig",
      "metadata": { "name": "unsafe-config" },
      "spec": {
        "schema_version": "${FLOW_SCHEMA_VERSION}",
        "trusted_producers": {
          "__proto__": {
            "polluted": true
          }
        }
      }
    }`)),
    /unsafe config path segment: __proto__/
  );
  assert.equal({}.polluted, undefined);
});

test("Resource-shaped project config validates metadata before normalization", () => {
  assert.throws(
    () => previewFlowConfigMerge(resourceConfigFixture(), {
      apiVersion: "flow.kontourai.io/v1alpha1",
      kind: "FlowProjectConfig",
      metadata: {
        labels: { example: "missing-name" }
      },
      spec: proposedConfigFixture()
    }),
    /config.metadata.name/
  );
  assert.throws(
    () => previewFlowConfigMerge(resourceConfigFixture(), {
      apiVersion: "flow.kontourai.io/v1alpha1",
      kind: "FlowProjectConfig",
      metadata: {
        name: "invalid-metadata",
        labels: { team: 42 }
      },
      spec: proposedConfigFixture()
    }),
    /config.metadata.labels.team must be a string/
  );
});

test("config merge accepts conflicting authority only with explicit exception reason and authority", () => {
  assert.throws(
    () => previewFlowConfigMerge(localConfigFixture(), proposedConfigFixture(), {
      acceptConflicts: ["$.trusted_producers.quality.tests"]
    }),
    /requires exception reason and authority/
  );

  const report = previewFlowConfigMerge(localConfigFixture(), proposedConfigFixture(), {
    acceptConflicts: ["$.trusted_producers.quality.tests"],
    exceptionReason: "project owner accepted kit authority update",
    authority: "owner@example.com"
  });

  assert.ok(report.exceptions.length >= 2);
  assert.equal(report.exceptions[0].reason, "project owner accepted kit authority update");
  assert.equal(report.exceptions[0].authority, "owner@example.com");
  assert.deepEqual(report.merged_config.trusted_producers["quality.tests"].producers, ["ci/kit"]);
  assert.deepEqual(report.merged_config.trusted_producers["quality.tests"].authority_traces, ["github:kit"]);
  assert.ok(report.conflicts.every((change) => !change.path.startsWith("$.trusted_producers.quality.tests")));
});

test("config merge markdown exposes human review buckets", () => {
  const report = previewFlowConfigMerge(localConfigFixture(), proposedConfigFixture());
  const markdown = renderConfigMergeMarkdown(report);
  assert.match(markdown, /# Flow Project Config Merge Report/);
  assert.match(markdown, /## Accepted Changes/);
  assert.match(markdown, /## Rejected Changes/);
  assert.match(markdown, /## Conflicts/);
  assert.match(markdown, /\$\.trusted_producers\.quality\.tests\.producers/);
});

test("config merge apply writes only accepted changes unless conflicts are explicitly accepted", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "flow-config-merge-"));
  await mkdir(path.join(cwd, ".flow"), { recursive: true });
  await writeFile(path.join(cwd, ".flow", "config.json"), `${JSON.stringify(localConfigFixture(), null, 2)}\n`);
  await writeFile(path.join(cwd, "proposal.json"), `${JSON.stringify(proposedConfigFixture(), null, 2)}\n`);

  const blocked = await applyFlowConfigMerge(cwd, "proposal.json");
  assert.equal(blocked.status, "blocked");
  let config = JSON.parse(await readFile(path.join(cwd, ".flow", "config.json"), "utf8"));
  assert.deepEqual(config.trusted_producers["quality.tests"].producers, ["ci/main"]);
  assert.equal(config.gate_overrides["verify-gate"].expectations["tests-passed"].required, true);

  const applied = await applyFlowConfigMerge(cwd, "proposal.json", {
    acceptConflicts: [
      "$.trusted_producers.quality.tests",
      "$.gate_overrides.verify-gate.expectations.tests-passed"
    ],
    exceptionReason: "maintainer accepted kit update",
    authority: "flow-maintainer"
  });
  assert.equal(applied.status, "applied");
  assert.ok(applied.exceptions.length > 0);
  config = JSON.parse(await readFile(path.join(cwd, ".flow", "config.json"), "utf8"));
  assert.deepEqual(config.trusted_producers["quality.tests"].producers, ["ci/kit"]);
  assert.equal(config.gate_overrides["verify-gate"].expectations["tests-passed"].required, false);
  assert.deepEqual(config.trusted_producers["quality.lint"].producers, ["lint/kit"]);
});
