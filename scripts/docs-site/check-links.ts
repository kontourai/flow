// Verifies every internal href/src in the built site/ resolves to a real file.
// Run after `npm run docs:build`: node scripts/docs-site/check-links.ts
import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const siteDir = path.join(repoRoot, "site");

async function htmlFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await htmlFiles(p)));
    else if (entry.name.endsWith(".html")) out.push(p);
  }
  return out;
}

let broken = 0;
for (const file of await htmlFiles(siteDir)) {
  const html = await readFile(file, "utf8");
  for (const match of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    const href = match[1];
    if (/^(https?:|mailto:|#)/.test(href)) continue;
    const target = path.join(path.dirname(file), href.split("#")[0]);
    if (!existsSync(target)) {
      console.error(`BROKEN ${path.relative(repoRoot, file)}: ${href}`);
      broken += 1;
    }
  }
}

if (broken > 0) {
  console.error(`${broken} broken internal link(s)`);
  process.exitCode = 1;
} else {
  console.log("site internal links OK");
}
