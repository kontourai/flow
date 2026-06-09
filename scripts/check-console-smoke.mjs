import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";
import { startFlowConsoleServer } from "../dist/console-server.js";

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
  await page.goto(server.url, { waitUntil: "networkidle" });

  const status = page.getByTestId("flow-console-status");
  await status.waitFor();
  await assert.match(await status.textContent(), /console-projection-fixture is active at Verify/);

  const nodes = page.locator('[data-testid="flow-console-node"]');
  assert.equal(await nodes.count(), 4);
  await page.locator('[data-testid="flow-console-graph"] .is-current').waitFor();
  assert.ok((await page.locator('[data-testid="flow-console-timeline"] .timeline-row').count()) >= 2);

  const gatePanel = page.getByTestId("flow-console-gate-panel");
  await assert.match(await gatePanel.textContent(), /verify-gate/);
  await assert.match(await gatePanel.textContent(), /Tests failed; route back to build/);
  await assert.match(await gatePanel.textContent(), /Tests passed through Surface trust/);

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
