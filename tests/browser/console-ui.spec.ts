import { expect, test, type Page } from "@playwright/test";

test("renders the Flow console projection with gates, graph, and links", async ({ page }) => {
  const consoleErrors = await loadFlowConsole(page);

  await expect(page).toHaveTitle(/console-projection-fixture \| Flow Console/);
  await expect(page.getByTestId("flow-console-status")).toContainText("console-projection-fixture is active at Verify");
  await expect(page.getByTestId("flow-console-node")).toHaveCount(4);
  await expect(page.locator('[data-testid="flow-console-graph"] .is-current')).toContainText("Verify");
  await expect(page.getByTestId("flow-console-timeline").locator(".timeline-row")).toHaveCount(2);

  const gatePanel = page.getByTestId("flow-console-gate-panel");
  await expect(gatePanel).toContainText("verify-gate");
  await expect(gatePanel).toContainText("Tests failed; route back to build");
  await expect(gatePanel).toContainText("Tests passed through Surface trust");

  const links = page.getByTestId("flow-console-links");
  await expect(links).toContainText("surface");
  await expect(links).toContainText("veritas");
  await expect(links.locator('[data-link-kind="surface"] a[href^="http://127.0.0.1:51231"]')).toHaveCount(1);
  await expect(links.locator('[data-link-kind="veritas"] a[href^="http://127.0.0.1:51232"]')).toHaveCount(1);
  await expect(links.locator('[data-link-kind="artifact"] a[href^="/artifacts/"]').first()).toBeVisible();
  await assertTokenStylesResolved(page);
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
