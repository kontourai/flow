import { expect, test, type Page } from "@playwright/test";

// <flow-run-panel> — dependency-free, read-only Flow run panel.
//
// These specs mount the element with a sample pre-derived FlowConsoleProjection
// (the same shape `projectFlowRun` emits) and assert it renders the process
// graph, gates, evidence, and route-backs incl. invalidated_steps — purely from
// the pre-derived projection, with NO in-browser derivation. The element module
// is served from the console-server static root at /flow-run-panel.js.

// A compact but representative projection. The route-back carries
// invalidated_steps; the evidence carries a pre-derived Surface bundle_report;
// the gate summary carries an XSS payload to assert escaping.
const SAMPLE_PROJECTION = {
  schema_version: "0.1",
  run: {
    run_id: "panel-fixture",
    definition_id: "demo",
    definition_version: "1",
    subject: "panel subject",
    status: "active",
    current_step: "verify",
    updated_at: "2026-06-07T14:20:00.000Z",
    params: {}
  },
  definition: { id: "demo", version: "1", title: "Demo flow", description: null, raw: {} },
  steps: [
    { id: "build", index: 0, label: "Build", next: "verify", gates: ["build-gate"], raw: {} },
    { id: "verify", index: 1, label: "Verify", next: "release", gates: ["verify-gate"], raw: {} },
    { id: "release", index: 2, label: "Release", next: null, gates: [], raw: {} }
  ],
  current_step: "verify",
  open_gates: ["verify-gate"],
  gates: [
    {
      id: "build-gate",
      step_id: "build",
      status: "pass",
      summary: "Build complete",
      is_open: false,
      expectations: [{ id: "compiled", description: "Project compiles", required: true }],
      evidence: [],
      missing: [],
      optional_missing: []
    },
    {
      id: "verify-gate",
      step_id: "verify",
      // Gate summary contains an injection payload — must render as inert text.
      status: "route-back",
      summary: "<img src=x onerror=window.__xss=1>Tests failed",
      is_open: true,
      expectations: [{ id: "tests-passed", description: "Tests passed", required: true }],
      evidence: [
        {
          id: "ev.surface-tests",
          gate_id: "verify-gate",
          kind: "trust.bundle",
          status: "fail",
          producer: "hachure",
          external_links: [],
          // Pre-derived Surface TrustReport — handed to the nested element as-is.
          bundle_report: {
            source: "surface",
            generatedAt: "2026-06-07T14:19:00.000Z",
            claims: [{ id: "c1", status: "disputed", fieldOrBehavior: "tests", subjectType: "run", subjectId: "r1" }],
            evidence: [],
            transparencyGaps: []
          }
        }
      ],
      missing: ["tests-passed"],
      optional_missing: [],
      route_back_to: "build",
      route_reason: "implementation_defect",
      attempt: 1,
      max_attempts: 2
    }
  ],
  expectations: [],
  evidence: [],
  exceptions: [],
  transitions: [],
  route_backs: [
    {
      id: "gate_outcome.1",
      source: "gate_outcome",
      gate_id: "verify-gate",
      from_step: "verify",
      to_step: "build",
      route_back_to: "build",
      reason: "implementation_defect",
      selected_route: "implementation_defect",
      recovery_step: "build",
      attempt: 1,
      max_attempts: 2,
      limit_exceeded: false,
      invalidated_steps: ["release"],
      evidence_refs: ["ev.failed-tests"],
      expectation_ids: ["tests-passed"]
    }
  ],
  external_links: [],
  next_action: "Fix the failing tests and re-run verify.",
  continuation: "flow continue panel-fixture",
  report: null
};

async function mountPanel(page: Page, projection: unknown): Promise<string[]> {
  const consoleErrors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  page.on("pageerror", (e) => consoleErrors.push(e.message));

  // Load the console page first so the page origin can resolve the served
  // module, then register + mount the element with the pre-derived projection.
  await page.goto("/");
  await page.evaluate(async (proj) => {
    await import("/flow-run-panel.js");
    const host = document.createElement("div");
    host.id = "panel-host";
    document.body.append(host);
    const el = document.createElement("flow-run-panel") as HTMLElement & { projection?: unknown };
    el.projection = proj;
    host.append(el);
  }, projection);
  return consoleErrors;
}

function panel(page: Page) {
  return page.locator("#panel-host flow-run-panel");
}

test("renders the process graph, gates, evidence, and next action from the pre-derived projection", async ({ page }) => {
  const consoleErrors = await mountPanel(page, SAMPLE_PROJECTION);
  const el = panel(page);
  await expect(el).toHaveCount(1);

  // The element upgraded and rendered shadow content.
  await page.waitForFunction(() => {
    const node = document.querySelector("#panel-host flow-run-panel") as HTMLElement | null;
    return Boolean(node?.shadowRoot && node.shadowRoot.childElementCount > 0);
  });

  // Process graph: one node per step (build/verify/release).
  const nodes = el.locator(".graph-node");
  await expect(nodes).toHaveCount(3);
  await expect(el.locator(".graph-node.is-current")).toContainText("Verify");

  // Gates section: one gate block per gate, with status + checklist.
  await expect(el.getByTestId("flow-run-panel-gate")).toHaveCount(2);
  await expect(el.locator('[data-gate-id="verify-gate"] .checklist')).toContainText("Tests passed");

  // Evidence: trust.bundle row with a nested <surface-trust-panel> fed the
  // pre-derived report (set via .report — no in-browser derivation).
  const evidenceRow = el.locator('[data-gate-id="verify-gate"] .evidence-row');
  await expect(evidenceRow).toContainText("ev.surface-tests");
  const nested = evidenceRow.locator("surface-trust-panel");
  await expect(nested).toHaveCount(1);
  const hasReport = await nested.evaluate((node) => Boolean((node as unknown as { report?: unknown }).report));
  expect(hasReport).toBe(true);

  // Next action banner.
  await expect(el.getByTestId("flow-console-next-action")).toContainText("Fix the failing tests");

  expect(consoleErrors).toEqual([]);
});

test("reflects route-backs incl. invalidated_steps without deriving them", async ({ page }) => {
  const consoleErrors = await mountPanel(page, SAMPLE_PROJECTION);
  const el = panel(page);

  const routeBacks = el.getByTestId("flow-console-route-backs");
  await expect(routeBacks.locator(".route-back-row")).toHaveCount(1);
  await expect(routeBacks).toContainText("verify → build");
  await expect(routeBacks).toContainText("implementation_defect");

  // invalidated_steps comes straight off the projection — assert the exact chip.
  const invalidated = el.getByTestId("route-back-invalidated");
  await expect(invalidated).toBeVisible();
  await expect(invalidated.locator('[data-invalidated-step="release"]')).toHaveCount(1);
  await expect(invalidated.locator('[data-invalidated-step="release"]')).toContainText("release");

  expect(consoleErrors).toEqual([]);
});

test("escapes untrusted projection text (no HTML injection from a gate summary)", async ({ page }) => {
  const consoleErrors = await mountPanel(page, SAMPLE_PROJECTION);
  const el = panel(page);

  // The summary payload must render as inert text, not execute or inject an <img>.
  const summary = el.locator('[data-gate-id="verify-gate"] .gate-summary');
  await expect(summary).toContainText("<img src=x onerror=window.__xss=1>Tests failed");
  const injected = await page.evaluate(() => {
    const node = document.querySelector("#panel-host flow-run-panel") as HTMLElement | null;
    return {
      xssFired: (window as unknown as { __xss?: number }).__xss === 1,
      imgCount: node?.shadowRoot?.querySelectorAll("img").length ?? 0
    };
  });
  expect(injected.xssFired).toBe(false);
  expect(injected.imgCount).toBe(0);

  expect(consoleErrors).toEqual([]);
});

test("customElements.define is idempotent (re-importing does not throw)", async ({ page }) => {
  const consoleErrors = await mountPanel(page, SAMPLE_PROJECTION);

  // Re-import the module several times; the guard must prevent a duplicate
  // define() DOMException and the registered constructor must be stable.
  const result = await page.evaluate(async () => {
    const first = customElements.get("flow-run-panel");
    let threw = false;
    try {
      await import("/flow-run-panel.js?reimport=1");
      await import("/flow-run-panel.js?reimport=2");
    } catch (e) {
      threw = true;
      void e;
    }
    const second = customElements.get("flow-run-panel");
    return { threw, stable: first === second && Boolean(second) };
  });

  expect(result.threw).toBe(false);
  expect(result.stable).toBe(true);
  expect(consoleErrors).toEqual([]);
});

test("renders an empty state when no projection is set", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(async () => {
    await import("/flow-run-panel.js");
    const host = document.createElement("div");
    host.id = "empty-host";
    document.body.append(host);
    host.append(document.createElement("flow-run-panel"));
  });
  const empty = await page.evaluate(() => {
    const node = document.querySelector("#empty-host flow-run-panel") as HTMLElement | null;
    return node?.shadowRoot?.querySelector(".empty")?.textContent ?? null;
  });
  expect(empty).toContain("No Flow run projection loaded yet.");
});
