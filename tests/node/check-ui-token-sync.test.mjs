import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFile, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  declarations,
  flowThemeBodies,
  flowTokensForColorSchemeMedia,
  parseRules,
  readUiTokenSources,
  ruleBody,
  tokenValue,
} from "../../scripts/lib/ui-tokens.mjs";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const read = (relative) => readFile(path.join(repoRoot, relative), "utf8");
const sources = await readUiTokenSources();
const bodies = flowThemeBodies(sources);

// A copy of the repo's drift gate, its vendored assets and (linked) installed
// packages, so the gate can be run as a child process against a vendored copy
// the test is free to damage.
async function replica() {
  const dir = await mkdtemp(path.join(tmpdir(), "flow-ui-assets-"));
  await mkdir(path.join(dir, "scripts"), { recursive: true });
  await mkdir(path.join(dir, "node_modules", "@kontourai"), { recursive: true });
  await mkdir(path.join(dir, "src", "console-ui"), { recursive: true });
  await cp(path.join(repoRoot, "scripts", "sync-ui-assets.mjs"), path.join(dir, "scripts", "sync-ui-assets.mjs"));
  await cp(path.join(repoRoot, "src", "console-ui", "vendor"), path.join(dir, "src", "console-ui", "vendor"), { recursive: true });
  for (const name of ["ui", "surface"]) {
    await symlink(path.join(repoRoot, "node_modules", "@kontourai", name), path.join(dir, "node_modules", "@kontourai", name), "dir");
  }
  return dir;
}

function runCheck(dir) {
  return spawnSync(process.execPath, [path.join(dir, "scripts", "sync-ui-assets.mjs"), "--check"], { encoding: "utf8" });
}

test("the committed vendored UI assets match the installed packages", () => {
  const result = spawnSync(process.execPath, [path.join(repoRoot, "scripts", "sync-ui-assets.mjs"), "--check"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("the drift gate exits non-zero when a vendored token is edited, added or removed", async (t) => {
  const dir = await replica();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const themes = path.join(dir, "src", "console-ui", "vendor", "ui", "tokens", "themes.css");
  const original = await readFile(themes, "utf8");
  assert.equal(runCheck(dir).status, 0, "an untouched replica must pass, or the failures below prove nothing");

  assert.ok(original.includes("#3890ae"));
  await writeFile(themes, original.replace("#3890ae", "#2f88a6"));
  const edited = runCheck(dir);
  assert.equal(edited.status, 1);
  assert.match(edited.stderr, /Vendor file drifted: src\/console-ui\/vendor\/ui\/tokens\/themes\.css/);
  assert.match(edited.stderr, /npm run sync:ui/);
  await writeFile(themes, original);
  assert.equal(runCheck(dir).status, 0);

  const extra = path.join(dir, "src", "console-ui", "vendor", "ui", "tokens", "extra.css");
  await appendFile(extra, ":root {}\n");
  const added = runCheck(dir);
  assert.equal(added.status, 1);
  assert.match(added.stderr, /Vendor directory drifted: src\/console-ui\/vendor\/ui\/tokens/);
  await rm(extra);

  await rm(path.join(dir, "src", "console-ui", "vendor", "ui", "tokens", "fonts", "fraunces-latin.woff2"));
  assert.equal(runCheck(dir).status, 1);
});

test("npm test checks vendored assets before the build can re-sync them", async () => {
  const { scripts } = JSON.parse(await read("package.json"));
  const steps = scripts["test:locked"].split("&&").map((step) => step.trim());
  assert.equal(steps[0], "npm run check:ui-assets");
  assert.ok(steps.indexOf("npm run build") > 0);
  assert.equal(scripts["check:ui-assets"], "node scripts/sync-ui-assets.mjs --check");
});

test("the docs-site token sheet carries the installed Flow theme in both modes", () => {
  const sheet = flowTokensForColorSchemeMedia(sources);
  const [darkPart, lightPart] = sheet.split("@media (prefers-color-scheme: light)");
  assert.ok(lightPart, "light values must sit under prefers-color-scheme");
  const last = (css, name) => parseRules(css).map((rule) => declarations(rule.body).get(name)).filter(Boolean).at(-1);

  // Pinned literals for ui 1.18 (brand-as-text AA): a ui release that moves
  // them should be looked at, not absorbed silently.
  assert.equal(last(darkPart, "--k-brand"), "#3890ae");
  assert.equal(last(darkPart, "--k-action"), "#2f88a6");
  assert.equal(last(darkPart, "--k-focus"), "#2f88a6");
  assert.equal(last(darkPart, "--k-text-faint"), "#75889d");
  assert.equal(last(darkPart, "--k-brand"), tokenValue(bodies.darkFlow, "--k-brand"));

  // The media block is `@media { :root {…} :root {…} }`; drop the wrapper.
  const lightRules = lightPart.slice(lightPart.indexOf("{") + 1, lightPart.lastIndexOf("}"));
  assert.equal(last(lightRules, "--k-brand"), "#1f6f88");
  assert.equal(last(lightRules, "--k-text-faint"), "#6a707b");
  assert.equal(last(lightRules, "--k-bg"), tokenValue(bodies.light, "--k-bg"));
  assert.equal(last(lightRules, "color-scheme"), "light");
});

test("token extraction refuses a missing rule or declaration instead of emitting nothing", () => {
  assert.throws(() => flowThemeBodies({ tokens: sources.tokens, themes: sources.themes.replaceAll(".theme-flow", ".theme-renamed") }), /expected exactly one rule for `\.theme-flow`, found 0/);
  assert.throws(() => ruleBody(`${sources.tokens}\n:root { --k-bg: red; }`, ":root"), /found 2/);
  assert.throws(() => tokenValue(bodies.dark, "--k-not-a-token"), /no --k-not-a-token declaration/);
  assert.throws(() => parseRules("@media print { :root { --k-bg: red; } }"), /nested blocks/);
});

test("token extraction refuses a Flow rule that has lost its tokens", () => {
  const emptied = sources.themes.replace(/\.theme-flow \{[^}]*\}/, ".theme-flow {}");
  assert.notEqual(emptied, sources.themes, "the injection must reach the rule");
  assert.throws(() => flowThemeBodies({ tokens: sources.tokens, themes: emptied }), /themes\.css `\.theme-flow`: missing --k-brand, --k-action, --k-action-contrast, --k-focus/);
  assert.throws(() => flowTokensForColorSchemeMedia({ tokens: sources.tokens, themes: emptied }), /missing --k-brand/);
  const noBrand = sources.tokens.replace("--k-brand: #0e7c64;", "");
  assert.notEqual(noBrand, sources.tokens);
  assert.throws(() => flowThemeBodies({ tokens: noBrand, themes: sources.themes }), /tokens\.css `\[data-theme="light"\]`: missing --k-brand/);
});

test("braces, semicolons and commas inside quoted values are text", () => {
  const css = `.a, .b[title="x,y"] { --k-x: "}"; --k-y: 'a;b{'; --k-z: 1px; }\n.c { --k-w: 2px; }`;
  const rules = parseRules(css);
  assert.equal(rules.length, 2);
  assert.deepEqual(rules[0].selectors, [".a", '.b[title="x,y"]']);
  assert.deepEqual([...declarations(rules[0].body)], [["--k-x", '"}"'], ["--k-y", "'a;b{'"], ["--k-z", "1px"]]);
  assert.equal(tokenValue(ruleBody(css, ".c"), "--k-w"), "2px");
  // A comment marker inside a string is text; a real comment is dropped.
  const quotedComment = parseRules(`.a { --k-x: "/*"; } /* note { */ .b { --k-y: "*/"; }`);
  assert.deepEqual(quotedComment.map((rule) => [rule.selectors[0], rule.body]), [[".a", '--k-x: "/*";'], [".b", '--k-y: "*/";']]);
  assert.throws(() => parseRules(".a { --k-x: 1px; } /* open"), /unterminated comment/);
  assert.throws(() => parseRules(`.a { --k-x: "oops; }`), /unterminated string/);
  assert.throws(() => parseRules(".a { --k-x: 1px;"), /unterminated rule/);
  assert.throws(() => parseRules(".a { } }"), /unbalanced/);
});

test("selector lists split on top-level commas only", () => {
  const rule = parseRules(sources.themes).find((entry) => entry.selectors.includes('[data-theme="light"].theme-flow'));
  assert.equal(rule.selectors.length, 3);
  assert.ok(rule.selectors[1].endsWith('[data-theme="light"] [data-theme="dark"] *))'), rule.selectors[1]);
});

// Site-local custom properties that are deliberately not @kontourai/ui tokens.
const DOCS_LOCAL_TOKENS = ["--k-brand-bright"];

test("docs-site styles declare no @kontourai/ui token and use only declared ones", async () => {
  const styles = await read("scripts/docs-site/styles.css");
  const declared = [...styles.matchAll(/(--k-[a-z0-9-]+)\s*:/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(declared)], DOCS_LOCAL_TOKENS, "docs-site styles must not re-declare ui tokens; build.ts takes them from the package");

  const available = new Set([...declarations(bodies.dark).keys(), ...DOCS_LOCAL_TOKENS]);
  const used = new Set([...styles.matchAll(/var\((--k-[a-z0-9-]+)/g)].map((match) => match[1]));
  assert.ok(used.has("--k-action"), "the scan must reach the stylesheet's var() uses");
  assert.deepEqual([...used].filter((name) => !available.has(name)), []);
});

test("console styles use only tokens the vendored sheet declares", async () => {
  const vendored = declarations(ruleBody(await read("src/console-ui/vendor/ui/tokens/tokens.css"), ":root"));
  const styles = await read("src/console-ui/styles.css");
  const used = new Set([...styles.matchAll(/var\((--k-[a-z0-9-]+)/g)].map((match) => match[1]));
  assert.ok(used.has("--k-focus"), "the scan must reach the stylesheet's var() uses");
  assert.deepEqual([...used].filter((name) => !vendored.has(name)), []);
  assert.deepEqual([...styles.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((match) => match[0]), [], "console styles take colors from tokens");
});

test("docs-site literals that cannot read a custom property match the tokens", async () => {
  const favicon = await read("scripts/docs-site/favicon.svg");
  const colors = [...new Set([...favicon.matchAll(/#[0-9a-fA-F]{6}\b/g)].map((match) => match[0].toLowerCase()))].sort();
  const styles = await read("scripts/docs-site/styles.css");
  const bright = styles.match(/--k-brand-bright:\s*(#[0-9a-f]{6})/)?.[1];
  // The favicon is the Flow accent gradient on dark contrast ink. An SVG file
  // cannot read the page's tokens, so each color is held to its source here.
  const expected = [
    bright, // site-local tint (DOCS_LOCAL_TOKENS)
    tokenValue(bodies.darkFlow, "--k-action"), // the Flow accent
    tokenValue(bodies.dark, "--k-brand-contrast"),
  ].sort();
  assert.deepEqual(colors, expected);
  assert.deepEqual(expected, ["#06080b", "#2f88a6", "#5cc4e0"].sort());
});
