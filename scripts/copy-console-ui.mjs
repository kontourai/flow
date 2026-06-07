import { cp, mkdir } from "node:fs/promises";

await mkdir("dist/console-ui", { recursive: true });
await cp("src/console-ui/index.html", "dist/console-ui/index.html");
await cp("src/console-ui/styles.css", "dist/console-ui/styles.css");
