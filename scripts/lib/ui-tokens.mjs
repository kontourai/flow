// Reads @kontourai/ui token rules from the installed package so Flow's
// generated surfaces take their values from it instead of from hand copies.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const uiPackageRoot = path.join(repoRoot, "node_modules", "@kontourai", "ui");

export async function readUiTokenSources(packageRoot = uiPackageRoot) {
  const [tokens, themes] = await Promise.all([
    readFile(path.join(packageRoot, "tokens", "tokens.css"), "utf8"),
    readFile(path.join(packageRoot, "tokens", "themes.css"), "utf8"),
  ]);
  return { tokens, themes };
}

// Top-level rules of a stylesheet as { selectors, body }. Comments are
// dropped first; the token sheets have no nested blocks, and a nested block
// is refused rather than mis-read.
export function parseRules(css) {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = [];
  let cursor = 0;
  while (true) {
    const open = source.indexOf("{", cursor);
    if (open === -1) break;
    const close = source.indexOf("}", open);
    if (close === -1) throw new Error("ui tokens: unterminated rule");
    const body = source.slice(open + 1, close);
    if (body.includes("{")) throw new Error("ui tokens: nested blocks are not supported");
    rules.push({ selectors: splitSelectors(source.slice(cursor, open)), body: body.trim() });
    cursor = close + 1;
  }
  return rules;
}

// Split a selector list on top-level commas only: the theme selectors carry
// comma lists inside :where(:not(a, b)).
function splitSelectors(text) {
  const selectors = [];
  let depth = 0;
  let current = "";
  for (const char of text) {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (char === "," && depth === 0) {
      selectors.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim()) selectors.push(current.trim());
  return selectors;
}

// The body of the one rule that lists `selector`. Zero or several matches
// throw: a renamed or split rule must stop the build, not drop its values.
export function ruleBody(css, selector, label = "ui tokens") {
  const matches = parseRules(css).filter((rule) => rule.selectors.includes(selector));
  if (matches.length !== 1) {
    throw new Error(`${label}: expected exactly one rule for \`${selector}\`, found ${matches.length}`);
  }
  return matches[0].body;
}

export function declarations(body) {
  const map = new Map();
  for (const part of body.split(";")) {
    const index = part.indexOf(":");
    if (index === -1) continue;
    map.set(part.slice(0, index).trim(), part.slice(index + 1).trim().replace(/\s+/g, " "));
  }
  return map;
}

export function tokenValue(body, name, label = "ui tokens") {
  const value = declarations(body).get(name);
  if (!value) throw new Error(`${label}: no ${name} declaration`);
  return value;
}

// The four rules a `.theme-flow` page resolves, in cascade order.
export function flowThemeBodies({ tokens, themes }) {
  return {
    dark: ruleBody(tokens, ":root", "tokens.css"),
    darkFlow: ruleBody(themes, ".theme-flow", "themes.css"),
    light: ruleBody(tokens, '[data-theme="light"]', "tokens.css"),
    lightFlow: ruleBody(themes, '[data-theme="light"].theme-flow', "themes.css"),
  };
}

// Token sheet for a page that follows the OS color scheme instead of a
// data-theme attribute (the docs site): the package's dark contract and Flow
// theme on :root, and its light contract under prefers-color-scheme.
export function flowTokensForColorSchemeMedia(sources) {
  const { dark, darkFlow, light, lightFlow } = flowThemeBodies(sources);
  const block = (body, indent) => body.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => `${indent}${line}`).join("\n");
  return [
    "/* Generated from @kontourai/ui tokens by scripts/lib/ui-tokens.mjs. */",
    `:root {\n${block(dark, "  ")}\n}`,
    `:root {\n${block(darkFlow, "  ")}\n}`,
    "@media (prefers-color-scheme: light) {",
    `  :root {\n${block(light, "    ")}\n  }`,
    `  :root {\n${block(lightFlow, "    ")}\n  }`,
    "}",
    "",
  ].join("\n");
}
