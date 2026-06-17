import { cp, mkdir, rm } from "node:fs/promises";

await mkdir("dist/console-ui", { recursive: true });
await rm("dist/console-ui/vendor", { recursive: true, force: true });
await cp("src/console-ui/index.html", "dist/console-ui/index.html");
await cp("src/console-ui/styles.css", "dist/console-ui/styles.css");
// Standalone theming entry for the <flow-run-panel> subpath export.
await cp("src/console-ui/flow-run-panel.css", "dist/console-ui/flow-run-panel.css");
await cp("src/console-ui/vendor", "dist/console-ui/vendor", { recursive: true });
