/**
 * Tests for: flow kit validate, flow kit install, flow kit inspect
 *
 * All tests use local-path or file:// git fixtures — no network access.
 */
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { cliPath, execFile } from "./helpers/cli.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a minimal valid kit directory in a temp location.
 * @param {string} [kitId] - optional kit id override
 * @param {object} [extra] - extra kit.json fields (e.g. { skills: [...] })
 */
async function makeKit(kitId = "test-kit", extra = {}) {
  const kitDir = await mkdtemp(path.join(tmpdir(), `flow-kit-ops-${kitId}-`));
  const flowsDir = path.join(kitDir, "flows");
  await mkdir(flowsDir, { recursive: true });
  await writeFile(
    path.join(flowsDir, "review.flow.json"),
    JSON.stringify({
      id: `${kitId}.review`,
      version: "1",
      steps: [{ id: "review", next: null }],
      gates: {}
    })
  );
  await writeFile(
    path.join(kitDir, "kit.json"),
    JSON.stringify({
      schema_version: "1.0",
      id: kitId,
      name: `${kitId} display name`,
      flows: [{ id: `${kitId}.review`, path: "flows/review.flow.json" }],
      ...extra
    })
  );
  return kitDir;
}

// ---------------------------------------------------------------------------
// flow kit validate
// ---------------------------------------------------------------------------

test("flow kit validate accepts a valid kit directory", async () => {
  const kitDir = await makeKit("validate-kit-ok");
  const result = await execFile(process.execPath, [cliPath, "kit", "validate", kitDir]);
  assert.match(result.stdout, /valid Flow Kit container/);
});

test("flow kit validate --json returns stable payload", async () => {
  const kitDir = await makeKit("validate-kit-json");
  const result = await execFile(process.execPath, [cliPath, "kit", "validate", kitDir, "--json"]);
  const payload = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(payload), ["valid", "path", "error_count", "diagnostics"]);
  assert.equal(payload.valid, true);
  assert.equal(payload.error_count, 0);
});

test("flow kit validate exits 1 for invalid kit", async () => {
  const kitDir = await mkdtemp(path.join(tmpdir(), "flow-kit-validate-bad-"));
  await writeFile(
    path.join(kitDir, "kit.json"),
    JSON.stringify({ schema_version: "1.0", id: "BadId", name: "", flows: [] })
  );
  await assert.rejects(
    execFile(process.execPath, [cliPath, "kit", "validate", kitDir, "--json"]),
    (error) => {
      assert.equal(error.code, 1);
      const payload = JSON.parse(error.stdout);
      assert.equal(payload.valid, false);
      assert.ok(payload.error_count >= 3); // id, name, flows
      return true;
    }
  );
});

test("flow kit validate --json diagnostics have expected shape", async () => {
  const kitDir = await mkdtemp(path.join(tmpdir(), "flow-kit-validate-shape-"));
  await writeFile(
    path.join(kitDir, "kit.json"),
    JSON.stringify({ schema_version: "2.0", id: "my-kit", name: "My Kit", flows: [] })
  );
  await assert.rejects(
    execFile(process.execPath, [cliPath, "kit", "validate", kitDir, "--json"]),
    (error) => {
      const payload = JSON.parse(error.stdout);
      const diag = payload.diagnostics[0];
      assert.ok(diag.code);
      assert.ok(diag.severity);
      assert.ok(diag.path);
      assert.ok(diag.message);
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// flow kit install (local path)
// ---------------------------------------------------------------------------

test("flow kit install copies a local kit to dest", async () => {
  const kitDir = await makeKit("install-local");
  const dest = await mkdtemp(path.join(tmpdir(), "flow-kit-install-dest-"));
  const result = await execFile(
    process.execPath,
    [cliPath, "kit", "install", kitDir, "--dest", dest]
  );
  assert.match(result.stdout, /installed kit: install-local/);
  assert.match(result.stdout, /location:/);

  // Verify the kit was placed at dest/install-local/
  const installed = path.join(dest, "install-local");
  const manifest = JSON.parse(await readFile(path.join(installed, "kit.json"), "utf8"));
  assert.equal(manifest.id, "install-local");
});

test("flow kit install validates before placing — rejects invalid kit", async () => {
  const badKitDir = await mkdtemp(path.join(tmpdir(), "flow-kit-install-invalid-"));
  await writeFile(
    path.join(badKitDir, "kit.json"),
    JSON.stringify({ schema_version: "1.0", id: "BadId", name: "", flows: [] })
  );
  const dest = await mkdtemp(path.join(tmpdir(), "flow-kit-install-dest-bad-"));
  await assert.rejects(
    execFile(process.execPath, [cliPath, "kit", "install", badKitDir, "--dest", dest]),
    (error) => {
      assert.ok(error.message.includes("1") || error.code === 1 || error.stderr?.includes("validation failed"));
      return true;
    }
  );
});

test("flow kit install copies ALL kit files, not just core fields (agent-blind)", async () => {
  // Kit has extra consumer-defined assets (skills, docs) — install must copy them all
  const kitDir = await makeKit("agent-blind-kit");
  await mkdir(path.join(kitDir, "skills", "my-skill"), { recursive: true });
  await writeFile(path.join(kitDir, "skills", "my-skill", "SKILL.md"), "# My Skill");
  await mkdir(path.join(kitDir, "docs"), { recursive: true });
  await writeFile(path.join(kitDir, "docs", "guide.md"), "# Guide");
  // Update kit.json to declare them
  await writeFile(
    path.join(kitDir, "kit.json"),
    JSON.stringify({
      schema_version: "1.0",
      id: "agent-blind-kit",
      name: "Agent Blind Kit",
      flows: [{ id: "agent-blind-kit.review", path: "flows/review.flow.json" }],
      skills: [{ id: "my-skill", path: "skills/my-skill/SKILL.md" }],
      docs: [{ id: "guide", path: "docs/guide.md" }]
    })
  );

  const dest = await mkdtemp(path.join(tmpdir(), "flow-kit-install-blind-dest-"));
  await execFile(process.execPath, [cliPath, "kit", "install", kitDir, "--dest", dest]);

  const installed = path.join(dest, "agent-blind-kit");
  // Core files
  const manifest = JSON.parse(await readFile(path.join(installed, "kit.json"), "utf8"));
  assert.equal(manifest.id, "agent-blind-kit");
  // Consumer extension assets — must also be present
  const skillContent = await readFile(path.join(installed, "skills", "my-skill", "SKILL.md"), "utf8");
  assert.equal(skillContent.trim(), "# My Skill");
  const docContent = await readFile(path.join(installed, "docs", "guide.md"), "utf8");
  assert.equal(docContent.trim(), "# Guide");
});

// ---------------------------------------------------------------------------
// flow kit install (file:// git fixture — no network)
// ---------------------------------------------------------------------------

test("flow kit install accepts a file:// git URL (local bare clone)", async () => {
  // Create a source kit
  const kitDir = await makeKit("git-kit");

  // Create a bare git repo from the kit dir
  const bareRepo = await mkdtemp(path.join(tmpdir(), "flow-kit-bare-repo-"));
  await execFile("git", ["init", "--bare", bareRepo]);

  // Init a temp working copy, add files, push to bare
  const workDir = await mkdtemp(path.join(tmpdir(), "flow-kit-work-"));
  await execFile("git", ["init", workDir]);
  await execFile("git", ["-C", workDir, "config", "user.email", "test@test.local"]);
  await execFile("git", ["-C", workDir, "config", "user.name", "Test"]);
  // Copy kit files into working dir
  await cp(kitDir, workDir, { recursive: true });
  await execFile("git", ["-C", workDir, "add", "."]);
  await execFile("git", ["-C", workDir, "commit", "-m", "init"]);
  await execFile("git", ["-C", workDir, "remote", "add", "origin", bareRepo]);
  await execFile("git", ["-C", workDir, "push", "origin", "HEAD:main"]);

  const dest = await mkdtemp(path.join(tmpdir(), "flow-kit-git-dest-"));
  const fileUrl = `file://${bareRepo}#main`;
  const result = await execFile(
    process.execPath,
    [cliPath, "kit", "install", fileUrl, "--dest", dest]
  );
  assert.match(result.stdout, /installed kit: git-kit/);
  const manifest = JSON.parse(
    await readFile(path.join(dest, "git-kit", "kit.json"), "utf8")
  );
  assert.equal(manifest.id, "git-kit");
});

// ---------------------------------------------------------------------------
// flow kit inspect
// ---------------------------------------------------------------------------

test("flow kit inspect --json returns structural view only (no K-levels, no runtime targets)", async () => {
  const kitDir = await makeKit("inspect-kit", {
    skills: [{ id: "my-skill", path: "skills/SKILL.md" }],
    docs: [{ id: "guide", path: "docs/guide.md" }]
  });
  const result = await execFile(process.execPath, [cliPath, "kit", "inspect", kitDir, "--json"]);
  const payload = JSON.parse(result.stdout);

  assert.equal(payload.valid, true);
  assert.equal(payload.kitId, "inspect-kit");
  assert.equal(typeof payload.kitName, "string");
  assert.ok(Array.isArray(payload.flows));
  assert.ok(payload.flows.length > 0);
  assert.ok(Array.isArray(payload.assetClasses));

  // Agent-blind: lists NAMES of declared asset classes, not their contents
  assert.ok(payload.assetClasses.includes("skills"), `assetClasses: ${JSON.stringify(payload.assetClasses)}`);
  assert.ok(payload.assetClasses.includes("docs"), `assetClasses: ${JSON.stringify(payload.assetClasses)}`);

  // MUST NOT contain K-level interpretation or runtime target fields
  assert.equal(payload.kLevel, undefined, "inspect must not derive K-level");
  assert.equal(payload.runtimeTarget, undefined, "inspect must not derive runtime target");
  assert.equal(payload.activation, undefined, "inspect must not derive activation info");
});

test("flow kit inspect text output lists kit id, flows, and asset class names", async () => {
  const kitDir = await makeKit("inspect-text", {
    adapters: [{ id: "my-adapter", path: "adapters/adapter.json" }]
  });
  const result = await execFile(process.execPath, [cliPath, "kit", "inspect", kitDir]);
  assert.match(result.stdout, /kit: inspect-text/);
  assert.match(result.stdout, /flows:/);
  assert.match(result.stdout, /asset classes:/);
  assert.match(result.stdout, /adapters/);
});

test("flow kit inspect --json for kit with no extension fields shows empty assetClasses", async () => {
  const kitDir = await makeKit("no-extensions");
  const result = await execFile(process.execPath, [cliPath, "kit", "inspect", kitDir, "--json"]);
  const payload = JSON.parse(result.stdout);
  assert.ok(Array.isArray(payload.assetClasses));
  assert.equal(payload.assetClasses.length, 0);
});

test("flow kit inspect exits 1 and reports diagnostics for invalid kit", async () => {
  const kitDir = await mkdtemp(path.join(tmpdir(), "flow-kit-inspect-invalid-"));
  await writeFile(
    path.join(kitDir, "kit.json"),
    JSON.stringify({ schema_version: "2.0", id: "bad-id!", name: "", flows: [] })
  );
  await assert.rejects(
    execFile(process.execPath, [cliPath, "kit", "inspect", kitDir, "--json"]),
    (error) => {
      assert.equal(error.code, 1);
      const payload = JSON.parse(error.stdout);
      assert.equal(payload.valid, false);
      assert.ok(payload.diagnostics.length > 0);
      return true;
    }
  );
});

test("flow kit inspect --json flow entries include id and path", async () => {
  const kitDir = await makeKit("inspect-flows");
  const result = await execFile(process.execPath, [cliPath, "kit", "inspect", kitDir, "--json"]);
  const payload = JSON.parse(result.stdout);
  const [flow] = payload.flows;
  assert.ok("path" in flow, "flow entry must have path");
});


