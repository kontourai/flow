import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";
import { startFlowConsoleServer } from "../dist/index.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const screenshotPath = path.join(root, ".flow-agents", "flow-console-shell", "console-smoke.png");
const server = await startFlowConsoleServer({
  runId: "console-projection-fixture",
  cwd: path.join(root, "examples", "scenarios", "console-projection"),
  host: "127.0.0.1",
  port: 0
});

let browser;
try {
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  await page.goto(server.url, { waitUntil: "load" });

  // Header: status badge shows run status, subject shows run-id
  const status = page.getByTestId("flow-console-status");
  await status.waitFor();
  await assert.match(await status.textContent(), /active/);

  // Subject heading contains the run-id
  const subject = page.locator(".header-subject");
  await subject.waitFor();
  await assert.match(await subject.textContent(), /console-projection-fixture/);

  // Current step shown in header
  const step = page.locator(".header-step");
  await assert.match(await step.textContent(), /Verify/);

  // Graph nodes
  const nodes = page.locator('[data-testid="flow-console-node"]');
  assert.equal(await nodes.count(), 4);
  await page.locator('[data-testid="flow-console-graph"] .is-current').waitFor();

  // Timeline rows
  assert.ok((await page.locator('[data-testid="flow-console-timeline"] .timeline-row').count()) >= 2);

  // Open gate drawer by clicking the current (Verify) node
  const currentNode = page.locator('[data-testid="flow-console-graph"] .is-current[role="button"]');
  await currentNode.waitFor();
  await currentNode.click();

  // Drawer should be visible with gate content
  const drawer = page.locator('.drawer');
  await drawer.waitFor({ state: "visible" });
  await assert.match(await drawer.textContent(), /verify-gate/);
  await assert.match(await drawer.textContent(), /Tests passed through Hachure trust bundle/);

  // Checklist has items
  assert.ok((await drawer.locator(".checklist-item").count()) >= 1);

  // Evidence rows have badges
  assert.ok((await drawer.locator(".evidence-row").count()) >= 1);

  // Route callout appears for route-back gate (build-gate has route back — verify-gate may not)
  // Just confirm the drawer opened cleanly
  await page.keyboard.press("Escape");
  await drawer.waitFor({ state: "hidden" });

  // Links panel
  const links = page.getByTestId("flow-console-links");
  await assert.match(await links.textContent(), /surface/);
  await assert.match(await links.textContent(), /veritas/);
  await assert.match(await links.textContent(), /fallback artifact: evidence\/surface-tests.json|fallback artifact: artifacts\/scoped-diff.txt/);
  assert.ok((await links.locator('[data-link-kind="surface"] a[href^="http://127.0.0.1:51231"]').count()) >= 1);
  assert.ok((await links.locator('[data-link-kind="veritas"] a[href^="http://127.0.0.1:51232"]').count()) >= 1);
  assert.ok((await links.locator('[data-link-kind="artifact"] a[href^="/artifacts/"]').count()) >= 1);

  const traversal = await page.request.get(`${server.url}artifacts/%2e%2e/state.json`);
  assert.equal(traversal.status(), 404);

  await mkdir(path.dirname(screenshotPath), { recursive: true });
  await page.screenshot({ path: screenshotPath, fullPage: true });
  console.log(`console smoke screenshot: ${screenshotPath}`);
} finally {
  if (browser) await browser.close();
  await server.close();
}
