import { defineConfig, devices } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomInt } from "node:crypto";

const browserTestRoot = process.env.FLOW_CONSOLE_TEST_ROOT ?? mkdtempSync(path.join(tmpdir(), "kontourai-flow-browser-"));
const browserTestPort = Number(process.env.FLOW_CONSOLE_TEST_PORT ?? randomInt(20_000, 60_000));
process.env.FLOW_CONSOLE_TEST_ROOT = browserTestRoot;
process.env.FLOW_CONSOLE_TEST_PORT = String(browserTestPort);

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
