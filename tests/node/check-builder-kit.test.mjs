import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { cliPath, execFile } from "./helpers/cli.mjs";

const kitDir = fileURLToPath(new URL("../../kits/builder", import.meta.url));

test("Builder Kit is a valid Flow container and retains its structured workflow route", async () => {
  const validation = await execFile(process.execPath, [cliPath, "kit", "validate", kitDir, "--json"]);
  const validationPayload = JSON.parse(validation.stdout);
  assert.equal(validationPayload.valid, true, validation.stdout);
  assert.equal(validationPayload.error_count, 0, validation.stdout);

  const inspection = await execFile(process.execPath, [cliPath, "kit", "inspect", kitDir, "--json"]);
  const inspectionPayload = JSON.parse(inspection.stdout);
  assert.equal(inspectionPayload.valid, true, inspection.stdout);
  assert.equal(inspectionPayload.kitId, "builder");
  assert.deepEqual(
    inspectionPayload.flows.map((flow) => flow.id),
    ["builder.shape", "builder.build", "builder.publish-learn"]
  );

  const manifest = JSON.parse(await readFile(new URL("../../kits/builder/kit.json", import.meta.url), "utf8"));
  const definitions = await Promise.all(
    manifest.flows.map(async (flow) => ({
      ...flow,
      definition: JSON.parse(await readFile(new URL(`../../kits/builder/${flow.path}`, import.meta.url), "utf8"))
    }))
  );
  assert.deepEqual(
    definitions.map(({ id, definition }) => definition.id === id),
    [true, true, true],
    "each manifest entry must identify its packaged Flow Definition"
  );
  const [trigger] = manifest.workflow_triggers;
  assert.deepEqual(trigger, {
    id: "builder-build-work",
    when: "implementation-work-detected",
    target_flow_id: "builder.build",
    default_skill: "deliver",
    conditional_skills: [{ when: "user-requested-tdd", skill: "tdd-workflow" }],
    required_sequence: ["ensure-session", "plan-work", "execute-plan", "review-work", "verify-work"],
    post_verify_targets: ["release-readiness", "learning-review"]
  });
  assert.ok(
    manifest.flows.some((flow) => flow.id === trigger.target_flow_id),
    "workflow trigger target must be packaged as a Flow Definition"
  );
});
