import path from "node:path";
import { fileURLToPath } from "node:url";

import { startFlowConsoleServer } from "../../dist/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const server = await startFlowConsoleServer({
  runId: "console-projection-fixture",
  cwd: path.join(root, "examples", "scenarios", "console-projection"),
  host: "127.0.0.1",
  port: 4184,
});

console.log(`Flow console browser test server listening at ${server.url}`);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    await server.close();
    process.exit(0);
  });
}
