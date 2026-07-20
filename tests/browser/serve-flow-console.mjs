import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { startFlowConsoleServer } from "../../dist/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const browserTestRoot = process.env.FLOW_CONSOLE_TEST_ROOT;
const port = Number(process.env.FLOW_CONSOLE_TEST_PORT);
if (!browserTestRoot || !path.isAbsolute(browserTestRoot)) throw new Error("FLOW_CONSOLE_TEST_ROOT must be an absolute path");
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
    await rm(browserTestRoot, { recursive: true, force: true });
    process.exit(0);
  });
}
