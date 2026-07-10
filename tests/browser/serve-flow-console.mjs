import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { startFlowConsoleServer } from "../../dist/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fixtureCwd = path.join(root, ".kontourai", "flow", "test-projects", "console-projection");
const fixtureSource = path.join(root, "examples", "scenarios", "console-projection", "runtime-fixture", "console-projection-fixture");
const fixtureRunDir = path.join(fixtureCwd, ".kontourai", "flow", "runs", "console-projection-fixture");
await rm(fixtureCwd, { recursive: true, force: true });
await mkdir(path.dirname(fixtureRunDir), { recursive: true });
await cp(fixtureSource, fixtureRunDir, { recursive: true });
const server = await startFlowConsoleServer({
  runId: "console-projection-fixture",
  cwd: fixtureCwd,
  host: "127.0.0.1",
  port: 4184,
});

console.log(`Flow console browser test server listening at ${server.url}`);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    await server.close();
    await rm(fixtureCwd, { recursive: true, force: true });
    process.exit(0);
  });
}
