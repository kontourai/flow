import { defineConfig, devices } from "@playwright/test";
import { lstatSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomInt, randomUUID } from "node:crypto";

const markerName = ".flow-browser-owner.json";
const inheritedRoot = process.env.FLOW_CONSOLE_TEST_ROOT;
const inheritedToken = process.env.FLOW_CONSOLE_TEST_OWNER_TOKEN;
const browserTestRoot = inheritedRoot ?? mkdtempSync(path.join(tmpdir(), "kontourai-flow-browser-"));
const browserTestOwnerToken = inheritedToken ?? randomUUID();
if (inheritedRoot || inheritedToken) assertOwnedBrowserRoot(browserTestRoot, browserTestOwnerToken);
else writeFileSync(path.join(browserTestRoot, markerName), `${JSON.stringify({ token: browserTestOwnerToken })}\n`, { flag: "wx", mode: 0o600 });
const browserTestPort = Number(process.env.FLOW_CONSOLE_TEST_PORT ?? randomInt(20_000, 60_000));
process.env.FLOW_CONSOLE_TEST_ROOT = browserTestRoot;
process.env.FLOW_CONSOLE_TEST_PORT = String(browserTestPort);
process.env.FLOW_CONSOLE_TEST_OWNER_TOKEN = browserTestOwnerToken;

function assertOwnedBrowserRoot(root: string, token: string): void {
  if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith("kontourai-flow-browser-")) throw new Error("browser test root is not a dedicated Flow temp directory");
  const rootStat = lstatSync(root);
  const marker = path.join(root, markerName);
  const markerStat = lstatSync(marker);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || !markerStat.isFile() || markerStat.isSymbolicLink()) throw new Error("browser test root ownership marker is unsafe");
  if (JSON.parse(readFileSync(marker, "utf8")).token !== token) throw new Error("browser test root ownership marker does not match");
}

export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: `http://127.0.0.1:${browserTestPort}`,
    trace: "on-first-retry",
  },
  webServer: {
    command: "npm run build && node tests/browser/serve-flow-console.mjs",
    url: `http://127.0.0.1:${browserTestPort}/health`,
    env: {
      ...process.env,
      FLOW_CONSOLE_TEST_PORT: String(browserTestPort),
      FLOW_CONSOLE_TEST_ROOT: browserTestRoot,
      FLOW_CONSOLE_TEST_OWNER_TOKEN: browserTestOwnerToken,
    },
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [
    {
      name: "chromium-desktop",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 1000 },
      },
    },
    {
      name: "chromium-mobile",
      use: {
        ...devices["Pixel 7"],
      },
    },
  ],
});
