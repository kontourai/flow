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
  assert.equal("publisher_receipt" in preview, false);
  assert.deepEqual(preview.merged_config.trusted_producers["quality.tests"].producers, ["ci/main"]);
  assert.equal(preview.merged_config.apiVersion, undefined);

  const notCalled = async () => {
    throw new Error("publisher must not run for blocked merge");
  };
  const blocked = await applyFlowConfigMerge(cwd, "proposal.json", { publisher: notCalled });
  assert.equal(blocked.status, "blocked");
  assert.equal("publisher_receipt" in blocked, false);
  let stored = JSON.parse(await readFile(path.join(cwd, ".flow", "config.json"), "utf8"));
  assert.equal(stored.kind, "FlowProjectConfig");

  const applied = await applyFlowConfigMerge(cwd, "proposal.json", {
    acceptConflicts: [
      "$.trusted_producers.quality.tests",
      "$.gate_overrides.verify-gate.expectations.tests-passed"
    ],
    exceptionReason: "accepted Resource-shaped project config proposal",
    authority: "flow-maintainer",
    publisher: async (request) => ({
      api_version: "flow.kontourai.io/v1alpha1",
      status: "applied",
      publisher: "test-host",
      publication_id: "resource-config-apply",
      config_path: request.config_path,
      contents_sha256: request.contents_sha256
    })
  });
  assert.equal(applied.status, "applied");
  assert.ok(applied.publisher_receipt);
  assert.equal(applied.publisher_receipt.publisher, "test-host");
  stored = JSON.parse(await readFile(path.join(cwd, ".flow", "config.json"), "utf8"));
  assert.equal(stored.kind, "FlowProjectConfig", "Flow does not perform an unsafe fallback publication");
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
  assert.deepEqual(report.merged_config.trusted_producers["quality.tests"].authority_refs, ["github:kit"]);
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

test("config merge apply fails closed without a trusted publisher and never writes config", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "flow-config-merge-no-publisher-"));
  const configPath = path.join(cwd, ".flow", "config.json");
  const original = `${JSON.stringify(localConfigFixture(), null, 2)}\n`;
  await mkdir(path.dirname(configPath), { recursive: true });
  await Promise.all([
    writeFile(configPath, original),
    writeFile(path.join(cwd, "proposal.json"), `${JSON.stringify(proposedConfigFixture(), null, 2)}\n`)
  ]);

  await assert.rejects(
    () => applyFlowConfigMerge(cwd, "proposal.json"),
    /flow\.config\.merge\.publisher\.unavailable:.*flow config preview/
  );
  assert.equal(await readFile(configPath, "utf8"), original);
  await assert.rejects(() => readFile(path.join(cwd, ".flow.config.merge.lock"), "utf8"), /ENOENT/);
});

test("config merge hands canonical immutable bytes to a trusted publisher and validates its receipt", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "flow-config-merge-publisher-"));
  const configPath = path.join(cwd, ".flow", "config.json");
  const original = `${JSON.stringify(localConfigFixture(), null, 2)}\n`;
  await mkdir(path.dirname(configPath), { recursive: true });
  await Promise.all([
    writeFile(configPath, original),
    writeFile(path.join(cwd, "proposal.json"), `${JSON.stringify(proposedConfigFixture(), null, 2)}\n`)
  ]);

  let request;
  const applied = await applyFlowConfigMerge(cwd, "proposal.json", {
    acceptConflicts: [
      "$.trusted_producers.quality.tests",
      "$.gate_overrides.verify-gate.expectations.tests-passed"
    ],
    exceptionReason: "maintainer accepted kit update",
    authority: "flow-maintainer",
    publisher: async (received) => {
      request = received;
      assert.ok(Object.isFrozen(received));
      assert.equal(received.config_path, configPath);
      assert.equal(received.expected_config_sha256.length, 64);
      assert.equal(received.contents, `${JSON.stringify(JSON.parse(received.contents), null, 2)}\n`, "publisher receives canonical JSON bytes");
      return {
        api_version: "flow.kontourai.io/v1alpha1",
        status: "applied",
        publisher: "test-capability-host",
        publication_id: "publish-1",
        config_path: received.config_path,
        contents_sha256: received.contents_sha256
      };
    }
  });
  assert.equal(applied.status, "applied");
  assert.equal(applied.publisher_receipt.publication_id, "publish-1");
  assert.equal(JSON.parse(request.contents).trusted_producers["quality.tests"].producers[0], "ci/kit");
  assert.equal(await readFile(configPath, "utf8"), original, "only the host capability may publish bytes");
});

test("config merge snapshots every accessor-backed receipt field exactly once", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "flow-config-merge-hostile-receipt-"));
  await mkdir(path.join(cwd, ".flow"), { recursive: true });
  await Promise.all([
    writeFile(path.join(cwd, ".flow", "config.json"), `${JSON.stringify({ schema_version: FLOW_SCHEMA_VERSION, trusted_producers: {}, gate_overrides: {} }, null, 2)}\n`),
    writeFile(path.join(cwd, "proposal.json"), `${JSON.stringify({ schema_version: FLOW_SCHEMA_VERSION, trusted_producers: { "quality.tests": { producers: ["ci/tests"] } }, gate_overrides: {} }, null, 2)}\n`)
  ]);

  const reads = Object.create(null);
  const applied = await applyFlowConfigMerge(cwd, "proposal.json", {
    publisher: async (request) => {
      const values = {
        api_version: ["flow.kontourai.io/v1alpha1", "host.invalid/v9"],
        status: ["applied", "rejected"],
        publisher: ["host/accessor", "host/swapped"],
        publication_id: ["publication-accessor-1", "publication-swapped"],
        config_path: [request.config_path, "/outside/swapped/config.json"],
        contents_sha256: [request.contents_sha256, "0".repeat(64)]
      };
      return Object.defineProperties({}, Object.fromEntries(Object.entries(values).map(([field, fieldValues]) => [field, {
        enumerable: true,
        get() {
          reads[field] = (reads[field] ?? 0) + 1;
          return fieldValues[Math.min(reads[field] - 1, fieldValues.length - 1)];
        }
      }])));
    }
  });

  assert.deepEqual({ ...reads }, {
    api_version: 1,
    status: 1,
    publisher: 1,
    publication_id: 1,
    config_path: 1,
    contents_sha256: 1
  });
  assert.equal(applied.publisher_receipt.publisher, "host/accessor");
  assert.equal(applied.publisher_receipt.publication_id, "publication-accessor-1");
  assert.equal(applied.publisher_receipt.config_path, path.join(cwd, ".flow", "config.json"));
  assert.notEqual(applied.publisher_receipt.contents_sha256, "0".repeat(64));
  assert.ok(Object.isFrozen(applied.publisher_receipt));

  let publicationIdReads = 0;
  await assert.rejects(
    () => applyFlowConfigMerge(cwd, "proposal.json", {
      publisher: async (request) => ({
        api_version: "flow.kontourai.io/v1alpha1",
        status: "applied",
        publisher: "host/accessor",
        get publication_id() {
          publicationIdReads += 1;
          return publicationIdReads === 1 ? "" : "would-bypass-on-second-read";
        },
        config_path: request.config_path,
        contents_sha256: request.contents_sha256
      })
    }),
    /flow\.config\.merge\.publisher\.receipt\.invalid/
  );
  assert.equal(publicationIdReads, 1, "a second accessor read must not turn an invalid snapshot into a valid receipt");
});

test("config merge rejects invalid and failed publisher capabilities", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "flow-config-merge-invalid-publisher-"));
  await mkdir(path.join(cwd, ".flow"), { recursive: true });
  await Promise.all([
    writeFile(path.join(cwd, ".flow", "config.json"), `${JSON.stringify({ schema_version: FLOW_SCHEMA_VERSION, trusted_producers: {}, gate_overrides: {} }, null, 2)}\n`),
    writeFile(path.join(cwd, "proposal.json"), `${JSON.stringify({ schema_version: FLOW_SCHEMA_VERSION, trusted_producers: { "quality.tests": { producers: ["ci/tests"] } }, gate_overrides: {} }, null, 2)}\n`)
  ]);
  await assert.rejects(() => applyFlowConfigMerge(cwd, "proposal.json", { publisher: true }), /flow\.config\.merge\.publisher\.invalid/);
  const privateMarker = "token=publisher-secret-9fd5";
  const privatePath = "/internal/publisher/tenant-42/config.json";
  let publisherFailure;
  try {
    await applyFlowConfigMerge(cwd, "proposal.json", {
      publisher: async () => {
        throw new Error(`host refused ${privatePath}; ${privateMarker}`);
      }
    });
  } catch (error) {
    publisherFailure = error;
  }
  assert.ok(publisherFailure instanceof Error);
  assert.equal(
    publisherFailure.message,
    "flow.config.merge.publisher.failed: trusted config merge publisher failed; inspect the trusted host's internal diagnostics"
  );
  assert.doesNotMatch(String(publisherFailure), /publisher-secret-9fd5|\/internal\/publisher\/tenant-42/);
  assert.match(publisherFailure.cause?.message, /publisher-secret-9fd5/);

  const getterSecret = "getter-secret-1f97";
  let getterFailure;
  try {
    await applyFlowConfigMerge(cwd, "proposal.json", {
      publisher: async () => new Proxy({}, {
        get(_target, field) {
          if (field === "api_version") throw new Error(`receipt getter leaked ${getterSecret} at /host/private/receipt.json`);
          return undefined;
        }
      })
    });
  } catch (error) {
    getterFailure = error;
  }
  assert.ok(getterFailure instanceof Error);
  assert.equal(
    getterFailure.message,
    "flow.config.merge.publisher.failed: trusted config merge publisher failed; inspect the trusted host's internal diagnostics"
  );
  assert.doesNotMatch(String(getterFailure), /getter-secret-1f97|\/host\/private\/receipt\.json/);
  assert.match(getterFailure.cause?.message, /getter-secret-1f97/);
  let malformedReceiptFailure;
  try {
    await applyFlowConfigMerge(cwd, "proposal.json", { publisher: async () => ({ status: "applied" }) });
  } catch (error) {
    malformedReceiptFailure = error;
  }
  assert.ok(malformedReceiptFailure instanceof Error);
  assert.equal(
    malformedReceiptFailure.message,
    "flow.config.merge.publisher.receipt.invalid: publisher must return an applied receipt bound to the requested config path and bytes"
  );

  // A hostile host can retain the constructor/instance it observed from an
  // earlier malformed response. Replaying that internal class from publisher
  // execution must still cross the unconditional sanitized host boundary.
  const RecoveredReceiptError = malformedReceiptFailure.constructor;
  const replayedReceiptError = new RecoveredReceiptError();
  replayedReceiptError.message = "replayed-internal-secret-83bd at /host/private/replay.json";
  let replayFailure;
  try {
    await applyFlowConfigMerge(cwd, "proposal.json", {
      publisher: async () => { throw replayedReceiptError; }
    });
  } catch (error) {
    replayFailure = error;
  }
  assert.ok(replayFailure instanceof Error);
  assert.equal(
    replayFailure.message,
    "flow.config.merge.publisher.failed: trusted config merge publisher failed; inspect the trusted host's internal diagnostics"
  );
  assert.doesNotMatch(String(replayFailure), /replayed-internal-secret-83bd|\/host\/private\/replay\.json/);
  assert.equal(replayFailure.cause, replayedReceiptError);
});

test("config merge rejects malformed producer mappings before preview or publication", async () => {
  const publisher = async () => {
    throw new Error("publisher must not run for malformed config");
  };
  const malformed = {
    schema_version: FLOW_SCHEMA_VERSION,
    trusted_producers: { "quality.tests": { producers: "ci/not-an-array" } },
    gate_overrides: {}
  };
  assert.throws(
    () => previewFlowConfigMerge(malformed, proposedConfigFixture()),
    /flow config does not satisfy flow-config\.schema\.json/
  );
  assert.throws(
    () => previewFlowConfigMerge(localConfigFixture(), malformed),
    /flow config does not satisfy flow-config\.schema\.json/
  );

  const existing = await mkdtemp(path.join(tmpdir(), "flow-config-merge-malformed-existing-"));
  await mkdir(path.join(existing, ".flow"), { recursive: true });
  const existingPath = path.join(existing, ".flow", "config.json");
  const original = `${JSON.stringify(localConfigFixture(), null, 2)}\n`;
  await Promise.all([
    writeFile(existingPath, original),
    writeFile(path.join(existing, "proposal.json"), `${JSON.stringify(malformed, null, 2)}\n`)
  ]);
  await assert.rejects(
    () => applyFlowConfigMerge(existing, "proposal.json", { publisher }),
    /flow config does not satisfy flow-config\.schema\.json/
  );
  assert.equal(await readFile(existingPath, "utf8"), original, "malformed proposal must not rewrite an existing authority config");

  const missing = await mkdtemp(path.join(tmpdir(), "flow-config-merge-malformed-missing-"));
  await writeFile(path.join(missing, "proposal.json"), `${JSON.stringify(malformed, null, 2)}\n`);
  await assert.rejects(
    () => applyFlowConfigMerge(missing, "proposal.json", { publisher }),
    /flow config does not satisfy flow-config\.schema\.json/
  );
  await assert.rejects(
    () => readFile(path.join(missing, ".flow", "config.json"), "utf8"),
    /ENOENT/,
    "malformed proposal must not create a config file"
  );

  const legacy = {
    schema_version: FLOW_SCHEMA_VERSION,
    trusted_producers: { "quality.tests": { authority_traces: ["legacy:opaque"] } },
    gate_overrides: {}
  };
  assert.throws(
    () => previewFlowConfigMerge(localConfigFixture(), legacy),
    /authority_traces is removed; migrate its authority references to authority_refs/
  );
  await writeFile(path.join(existing, "legacy-proposal.json"), `${JSON.stringify(legacy, null, 2)}\n`);
  await assert.rejects(
    () => applyFlowConfigMerge(existing, "legacy-proposal.json", { publisher }),
    /authority_traces is removed; migrate its authority references to authority_refs/
  );
  assert.equal(await readFile(existingPath, "utf8"), original, "legacy authority authoring must not rewrite config");
});
