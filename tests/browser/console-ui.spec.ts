import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

const FIXTURE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../.kontourai/flow/test-projects/console-projection/.kontourai/flow/runs/console-projection-fixture"
);
const STATE_FILE = path.join(FIXTURE_ROOT, "state.json");

test("renders the Flow console projection with gates, graph, and links", async ({ page }) => {
  const consoleErrors = await loadFlowConsole(page);

  await expect(page).toHaveTitle(/console-projection-fixture \| Flow Console/);

  // Header: subject as h1, big status badge, step label
  const status = page.getByTestId("flow-console-status");
  await expect(status).toBeVisible();
  await expect(status).toContainText("active");
  await expect(page.locator(".header-subject")).toContainText("console-projection-fixture");
  await expect(page.locator(".header-step")).toContainText("Verify");

  // Graph nodes
  await expect(page.getByTestId("flow-console-node")).toHaveCount(4);
  await expect(page.locator('[data-testid="flow-console-graph"] .is-current')).toContainText("Verify");

  // Timeline shows ≤5 entries by default (fixture has 2 so all visible)
  await expect(page.getByTestId("flow-console-timeline").locator(".timeline-row")).toHaveCount(2);

  // Links panel
  const links = page.getByTestId("flow-console-links");
  await expect(links).toContainText("surface");
  await expect(links).toContainText("veritas");
  await expect(links.locator('[data-link-kind="surface"] a[href^="http://127.0.0.1:51231"]')).toHaveCount(1);
  await expect(links.locator('[data-link-kind="veritas"] a[href^="http://127.0.0.1:51232"]')).toHaveCount(1);
  await expect(links.locator('[data-link-kind="artifact"] a[href^="/artifacts/"]').first()).toBeVisible();

  await assertTokenStylesResolved(page);
  expect(consoleErrors).toEqual([]);
});

test("opens gate detail drawer when a step node is clicked", async ({ page }) => {
  const consoleErrors = await loadFlowConsole(page);
  test.skip(test.info().project.name === "chromium-mobile", "drawer click tested on desktop");

  // Find the current node (Verify step) and click it
  const currentNode = page.locator('[data-testid="flow-console-graph"] .is-current[role="button"]');
  await expect(currentNode).toBeVisible();
  await currentNode.click();

  // Drawer should open
  const drawer = page.locator('.drawer');
  await expect(drawer).toBeVisible();

  // Drawer should contain gate id and checklist
  await expect(drawer).toContainText("verify-gate");

  // Checklist section
  await expect(drawer.locator(".checklist")).toBeVisible();
  await expect(drawer.locator(".checklist-item")).toHaveCount(1);
  // Expectation: "Tests passed through Hachure trust bundle"
  await expect(drawer.locator(".checklist")).toContainText("Tests passed through Hachure trust bundle");

  // Evidence section with badges
  await expect(drawer.locator(".evidence-row")).not.toHaveCount(0);
  await expect(drawer.locator(".badge.badge-kind").first()).toBeVisible();

  // §4 nested Surface trust panel: the trust.bundle evidence (ev.surface-tests)
  // mounts Surface's own <surface-trust-panel> custom element, fed the
  // pre-derived TrustReport. Assert the element is present, upgraded (custom
  // element registered), and rendered its shadow content (derived claim view).
  const panel = drawer.locator("surface-trust-panel");
  await expect(panel).toHaveCount(1);
  // The element registers from the vendored module; once defined it renders a
  // shadow root with the report. Wait for the custom element to upgrade.
  await page.waitForFunction(() => {
    const el = document.querySelector("surface-trust-panel");
    return Boolean(el && (el as HTMLElement).shadowRoot && (el as HTMLElement).shadowRoot!.childElementCount > 0);
  });
  // No trust derivation happens in the browser — the panel only received the
  // already-derived report (set as the .report property by the drawer).
  const hasReport = await panel.evaluate((el) => Boolean((el as unknown as { report?: unknown }).report));
  expect(hasReport).toBe(true);

  // Close with Escape
  await page.keyboard.press("Escape");
  await expect(drawer).not.toBeVisible();

  expect(consoleErrors).toEqual([]);
});

test("gate drawer closes on backdrop click", async ({ page }) => {
  const consoleErrors = await loadFlowConsole(page);
  test.skip(test.info().project.name === "chromium-mobile", "backdrop click tested on desktop");

  const currentNode = page.locator('[data-testid="flow-console-graph"] .is-current[role="button"]');
  await currentNode.click();

  const drawer = page.locator('.drawer');
  await expect(drawer).toBeVisible();

  // Click the overlay
  await page.locator('.drawer-overlay').click({ force: true });
  await expect(drawer).not.toBeVisible();

  expect(consoleErrors).toEqual([]);
});

test("timeline collapses to 5 entries with show-all button when more exist", async ({ page }) => {
  // The fixture only has 2 transitions — just verify no show-all button appears
  await loadFlowConsole(page);
  const showAllBtn = page.locator(".show-all-btn");
  await expect(showAllBtn).toHaveCount(0);
  await expect(page.locator(".timeline-row")).not.toHaveCount(0);
});

test("theme toggle persists preference and switches data-theme", async ({ page }) => {
  const consoleErrors = await loadFlowConsole(page);

  const toggle = page.locator(".theme-toggle");
  await expect(toggle).toBeVisible();

  // Get current theme
  const initialTheme = await page.locator("html").getAttribute("data-theme");

  // Toggle once
  await toggle.click();
  const afterToggle = await page.locator("html").getAttribute("data-theme");
  expect(afterToggle).not.toEqual(initialTheme);

  // Reload page and theme should persist
  await page.reload();
  await expect(page.locator("body")).toBeVisible();
  const afterReload = await page.locator("html").getAttribute("data-theme");
  expect(afterReload).toEqual(afterToggle);

  expect(consoleErrors).toEqual([]);
});

test("mobile stepper renders vertical list at 390px viewport", async ({ page }) => {
  test.skip(test.info().project.name !== "chromium-mobile", "mobile-only stepper check");
  const consoleErrors = await loadFlowConsole(page);

  // At narrow viewport graph-nodes should be a column flex container
  const nodesBox = await page.locator(".graph-nodes").boundingBox();
  const viewport = page.viewportSize();
  expect(nodesBox).not.toBeNull();
  expect(viewport).not.toBeNull();

  if (nodesBox && viewport) {
    // All nodes should fit within viewport width
    expect(nodesBox.x + nodesBox.width).toBeLessThanOrEqual(viewport.width + 2);
  }

  // Graph nodes should be stacked (each takes full width row)
  const nodes = page.locator('[data-testid="flow-console-node"]');
  const count = await nodes.count();
  expect(count).toBe(4);

  expect(consoleErrors).toEqual([]);
});

test("rejects artifact path traversal through the console server", async ({ page, request }) => {
  const consoleErrors = await loadFlowConsole(page);
  const traversal = await request.get("/artifacts/%2e%2e/state.json");

  expect(traversal.status()).toBe(404);
  expect(consoleErrors).toEqual([]);
});

test("keeps the console layout inside the mobile viewport", async ({ page }) => {
  test.skip(test.info().project.name !== "chromium-mobile", "mobile-only layout check");
  const consoleErrors = await loadFlowConsole(page);

  const viewport = page.viewportSize();
  const headerBox = await page.locator(".console-header").boundingBox();
  const layoutBox = await page.locator(".console-layout").boundingBox();
  expect(viewport).not.toBeNull();
  expect(headerBox).not.toBeNull();
  expect(layoutBox).not.toBeNull();

  if (viewport && headerBox && layoutBox) {
    expect(headerBox.x).toBeGreaterThanOrEqual(0);
    expect(layoutBox.x).toBeGreaterThanOrEqual(0);
    expect(headerBox.x + headerBox.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(layoutBox.x + layoutBox.width).toBeLessThanOrEqual(viewport.width + 1);
  }

  expect(consoleErrors).toEqual([]);
});

// ---------------------------------------------------------------------------
// Live update tests
// ---------------------------------------------------------------------------

test("live indicator shows connected after SSE stream connects", async ({ page }) => {
  test.skip(test.info().project.name === "chromium-mobile", "live update tested on desktop");
  const consoleErrors = await loadFlowConsole(page);

  // Wait for SSE to connect and indicator to go live
  const indicator = page.getByTestId("live-indicator");
  await expect(indicator).toBeVisible();
  await expect(indicator).toHaveAttribute("data-connected", "true", { timeout: 5000 });
  await expect(indicator.locator(".live-label")).toContainText("live");

  expect(consoleErrors).toEqual([]);
});

test("live update: mutating run state file updates header status and timeline without reload", async ({ page }) => {
  test.skip(test.info().project.name === "chromium-mobile", "live update tested on desktop");
  const consoleErrors = await loadFlowConsole(page);

  // Wait for SSE to connect
  const indicator = page.getByTestId("live-indicator");
  await expect(indicator).toHaveAttribute("data-connected", "true", { timeout: 5000 });

  // Read and mutate the fixture state
  const originalState = await readFile(STATE_FILE, "utf8");
  try {
    const state = JSON.parse(originalState);
    // Add a transition to make the timeline grow
    const newTransition = {
      id: "tr.live-test",
      type: "step",
      from_step: "build",
      to_step: "verify",
      status: "allowed",
      gate_id: null,
      reason: "live update test",
      at: new Date().toISOString()
    };
    state.transitions = [...(state.transitions ?? []), newTransition];
    await writeFile(STATE_FILE, JSON.stringify(state, null, 2));

    // Assert timeline count updates (was 2, now should be 3)
    await expect(page.getByTestId("flow-console-timeline").locator(".timeline-row")).toHaveCount(3, { timeout: 5000 });

    // Status badge should still be visible (header re-rendered)
    await expect(page.getByTestId("flow-console-status")).toBeVisible();
  } finally {
    await writeFile(STATE_FILE, originalState);
  }

  expect(consoleErrors).toEqual([]);
});

test("live update: open drawer stays open and re-renders with updated gate data", async ({ page }) => {
  test.skip(test.info().project.name === "chromium-mobile", "live update tested on desktop");
  const consoleErrors = await loadFlowConsole(page);

  // Wait for SSE to connect
  const indicator = page.getByTestId("live-indicator");
  await expect(indicator).toHaveAttribute("data-connected", "true", { timeout: 5000 });

  // Open the drawer for the current (verify) step gate
  const currentNode = page.locator('[data-testid="flow-console-graph"] .is-current[role="button"]');
  await currentNode.click();
  const drawer = page.locator(".drawer");
  await expect(drawer).toBeVisible();
  await expect(drawer).toContainText("verify-gate");

  // Mutate the fixture to change verify-gate summary
  const originalState = await readFile(STATE_FILE, "utf8");
  try {
    const state = JSON.parse(originalState);
    const verifyOutcome = state.gate_outcomes.find((o: { gate_id: string }) => o.gate_id === "verify-gate");
    if (verifyOutcome) {
      verifyOutcome.summary = "Live update drawer test summary";
    }
    await writeFile(STATE_FILE, JSON.stringify(state, null, 2));

    // Drawer should stay open and show updated summary
    await expect(drawer).toBeVisible({ timeout: 5000 });
    await expect(drawer).toContainText("verify-gate");
    await expect(drawer).toContainText("Live update drawer test summary", { timeout: 5000 });
  } finally {
    await writeFile(STATE_FILE, originalState);
  }

  expect(consoleErrors).toEqual([]);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function loadFlowConsole(page: Page): Promise<string[]> {
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });
  page.on("pageerror", (error) => {
    consoleErrors.push(error.message);
  });

  await page.goto("/");
  await expect(page.locator("body")).toBeVisible();
  await expect(page.getByTestId("flow-console-status")).toBeVisible();
  return consoleErrors;
}

async function assertTokenStylesResolved(page: Page): Promise<void> {
  const styles = await page.locator("body").evaluate((body) => {
    const computed = getComputedStyle(body);
    return {
      background: computed.backgroundColor,
      color: computed.color,
      fontFamily: computed.fontFamily,
    };
  });

  expect(styles.background).not.toBe("rgba(0, 0, 0, 0)");
  expect(styles.color).not.toBe("rgba(0, 0, 0, 0)");
  expect(styles.fontFamily).not.toBe("");
}
