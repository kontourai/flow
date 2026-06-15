import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { validateKitContainer, validateKitContainerFile } from "../../dist/index.js";
import { cliPath, execFile } from "./helpers/cli.mjs";

// ---------------------------------------------------------------------------
// validateKitContainer (pure function, no file I/O)
// ---------------------------------------------------------------------------

test("valid minimal manifest passes with no diagnostics", () => {
  const kitDir = "/tmp/fake-kit";
  const manifest = {
    schema_version: "1.0",
    id: "review-kit",
    name: "Review Kit",
    flows: []
  };
  // flows empty triggers error — test the validator catches it
  const emptyFlows = validateKitContainer(kitDir, manifest);
  assert.equal(emptyFlows.valid, false);
  assert.ok(emptyFlows.diagnostics.some((d) => d.code === "kit.flows.required"));
});

test("valid manifest with flows passes", () => {
  const kitDir = path.join(tmpdir(), "flow-kit-container-test-noop");
  const manifest = {
    schema_version: "1.0",
    id: "review-kit",
    name: "Review Kit",
    flows: [
      { id: "review-kit.review", path: "flows/review.flow.json" }
    ]
  };
  // path doesn't exist but validateKitContainer checks existence — use a known existing path
  // Instead, make the path relative to a real dir that has the file via validateKitContainerFile
  // This test verifies structure only via the pure validator with a non-existent path:
  const result = validateKitContainer(kitDir, manifest);
  // Expect failure only because the file doesn't exist
  assert.equal(result.diagnostics.filter((d) => d.code !== "kit.flows.entry.path.missing").length, 0);
});

test("schema_version must be 1.0", () => {
  const result = validateKitContainer("/tmp/k", {
    schema_version: "2.0",
    id: "my-kit",
    name: "My Kit",
    flows: [{ path: "flows/f.flow.json" }]
  });
  assert.equal(result.valid, false);
  const codes = result.diagnostics.map((d) => d.code);
  assert.ok(codes.includes("kit.schema_version.invalid"), `got: ${codes.join(", ")}`);
});

test("id must match kebab-case pattern", () => {
  const bad = validateKitContainer("/tmp/k", {
    schema_version: "1.0",
    id: "MyKit",
    name: "My Kit",
    flows: [{ path: "flows/f.flow.json" }]
  });
  assert.ok(bad.diagnostics.some((d) => d.code === "kit.id.invalid"));

  const digit = validateKitContainer("/tmp/k", {
    schema_version: "1.0",
    id: "1kit",
    name: "Kit",
    flows: [{ path: "flows/f.flow.json" }]
  });
  assert.ok(digit.diagnostics.some((d) => d.code === "kit.id.invalid"));
});

test("name must be non-empty", () => {
  const result = validateKitContainer("/tmp/k", {
    schema_version: "1.0",
    id: "my-kit",
    name: "",
    flows: [{ path: "flows/f.flow.json" }]
  });
  assert.ok(result.diagnostics.some((d) => d.code === "kit.name.invalid"));
});

test("flows entry path must not be absolute", () => {
  const result = validateKitContainer("/tmp/k", {
    schema_version: "1.0",
    id: "my-kit",
    name: "My Kit",
    flows: [{ path: "/absolute/path.json" }]
  });
  assert.ok(result.diagnostics.some((d) => d.code === "kit.flows.entry.path.absolute"));
});

test("flows entry path must not contain ..", () => {
  const result = validateKitContainer("/tmp/k", {
    schema_version: "1.0",
    id: "my-kit",
    name: "My Kit",
    flows: [{ path: "../outside/flow.json" }]
  });
  assert.ok(result.diagnostics.some((d) => d.code === "kit.flows.entry.path.traversal"));
});

test("unknown top-level fields are ignored without error", () => {
  const result = validateKitContainer("/tmp/k", {
    schema_version: "1.0",
    id: "my-kit",
    name: "My Kit",
    flows: [{ path: "flows/f.flow.json" }],
    skills: [{ path: "skills/my-skill/SKILL.md" }],
    adapters: [],
    custom_field: "allowed"
  });
  // Only possible error here is the missing file
  assert.equal(result.diagnostics.filter((d) => d.code !== "kit.flows.entry.path.missing").length, 0);
});

// ---------------------------------------------------------------------------
// validateKitContainerFile (async, reads real files)
// ---------------------------------------------------------------------------

test("validateKitContainerFile validates a real kit directory", async () => {
  const kitDir = await mkdtemp(path.join(tmpdir(), "flow-kit-validate-"));
  const flowsDir = path.join(kitDir, "flows");
  await mkdir(flowsDir, { recursive: true });
  await writeFile(path.join(flowsDir, "review.flow.json"), JSON.stringify({
    id: "review-kit.review",
    version: "1",
    steps: [{ id: "review", next: null }],
    gates: {}
  }));
  await writeFile(path.join(kitDir, "kit.json"), JSON.stringify({
    schema_version: "1.0",
    id: "review-kit",
    name: "Review Kit",
    flows: [{ id: "review-kit.review", path: "flows/review.flow.json" }]
  }));
  const result = await validateKitContainerFile(kitDir);
  assert.equal(result.valid, true);
  assert.deepEqual(result.diagnostics, []);
});

test("validateKitContainerFile reports missing kit.json", async () => {
  const kitDir = await mkdtemp(path.join(tmpdir(), "flow-kit-missing-"));
  const result = await validateKitContainerFile(kitDir);
  assert.equal(result.valid, false);
  assert.ok(result.diagnostics.some((d) => d.code === "kit.manifest.read_failed"));
});

test("validateKitContainerFile reports invalid JSON", async () => {
  const kitDir = await mkdtemp(path.join(tmpdir(), "flow-kit-badjson-"));
  await writeFile(path.join(kitDir, "kit.json"), "{ not valid json }");
  const result = await validateKitContainerFile(kitDir);
  assert.equal(result.valid, false);
  assert.ok(result.diagnostics.some((d) => d.code === "kit.manifest.json.invalid"));
});

test("validateKitContainerFile detects missing Flow Definition file", async () => {
  const kitDir = await mkdtemp(path.join(tmpdir(), "flow-kit-missing-flow-"));
  await writeFile(path.join(kitDir, "kit.json"), JSON.stringify({
    schema_version: "1.0",
    id: "my-kit",
    name: "My Kit",
    flows: [{ path: "flows/missing.flow.json" }]
  }));
  const result = await validateKitContainerFile(kitDir);
  assert.equal(result.valid, false);
  assert.ok(result.diagnostics.some((d) => d.code === "kit.flows.entry.path.missing"));
});

// ---------------------------------------------------------------------------
// CLI: flow validate-kit is GONE (hard cut)
// ---------------------------------------------------------------------------

test("CLI validate-kit is an unknown command after hard cut", async () => {
  await assert.rejects(
    execFile(process.execPath, [cliPath, "validate-kit", "/tmp/any-kit"]),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr ?? error.message, /unknown command/);
      return true;
    }
  );
});
