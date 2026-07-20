import { cp, lstat, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { startFlowConsoleServer } from "../../dist/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const browserTestRoot = process.env.FLOW_CONSOLE_TEST_ROOT;
const browserTestOwnerToken = process.env.FLOW_CONSOLE_TEST_OWNER_TOKEN;
const port = Number(process.env.FLOW_CONSOLE_TEST_PORT);
await assertOwnedBrowserRoot(browserTestRoot, browserTestOwnerToken);
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error("FLOW_CONSOLE_TEST_PORT must be a valid port");
const fixtureCwd = path.join(browserTestRoot, ".kontourai", "flow", "test-projects", "console-projection");
const fixtureSource = path.join(root, "examples", "scenarios", "console-projection", "runtime-fixture", "console-projection-fixture");
const fixtureRunDir = path.join(fixtureCwd, ".kontourai", "flow", "runs", "console-projection-fixture");
await rm(fixtureCwd, { recursive: true, force: true });
await mkdir(path.dirname(fixtureRunDir), { recursive: true });
await cp(fixtureSource, fixtureRunDir, { recursive: true });
const server = await startFlowConsoleServer({
  runId: "console-projection-fixture",
  cwd: fixtureCwd,
  host: "127.0.0.1",
  port,
});

console.log(`Flow console browser test server listening at ${server.url}`);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    await server.close();
    await assertOwnedBrowserRoot(browserTestRoot, browserTestOwnerToken);
    await rm(browserTestRoot, { recursive: true, force: true });
    process.exit(0);
  });
}

async function assertOwnedBrowserRoot(root, token) {
  if (typeof root !== "string" || path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith("kontourai-flow-browser-")) throw new Error("browser test root is not a dedicated Flow temp directory");
  if (typeof token !== "string" || token.length < 1) throw new Error("browser test owner token is missing");
  const marker = path.join(root, ".flow-browser-owner.json");
  const [rootStat, markerStat, markerValue] = await Promise.all([lstat(root), lstat(marker), readFile(marker, "utf8")]);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || !markerStat.isFile() || markerStat.isSymbolicLink()) throw new Error("browser test root ownership marker is unsafe");
  if (JSON.parse(markerValue).token !== token) throw new Error("browser test root ownership marker does not match");
}
