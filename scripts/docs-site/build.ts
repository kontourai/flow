// Builds the Kontour Flow GitHub Pages site from README.md and docs/ into site/.
// Run with Node >= 22.18 (native TypeScript type stripping): node scripts/docs-site/build.ts
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { marked } from "marked";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const docsDir = path.join(repoRoot, "docs");
const outDir = path.join(repoRoot, "site");
const repoUrl = "https://github.com/kontourai/flow";
const siteUrl = "https://kontourai.github.io/flow";
const pkg = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8")) as { version: string };

interface PageDef {
  src: string;
  out: string;
  navTitle: string;
  section: string;
}

interface NavSection {
  title: string;
  pages: PageDef[];
}

const pages: PageDef[] = [
  { src: "getting-started.md", out: "getting-started.html", navTitle: "Getting Started", section: "Learn" },
  { src: "use-cases.md", out: "use-cases.html", navTitle: "Use Cases", section: "Learn" },
  { src: "cli.md", out: "cli.html", navTitle: "CLI Reference", section: "Reference" },
  { src: "library.md", out: "library.html", navTitle: "Library", section: "Reference" },
  { src: "evidence.md", out: "evidence.html", navTitle: "Evidence", section: "Reference" },
  { src: "gates-and-route-back.md", out: "gates-and-route-back.html", navTitle: "Gates & Route-Back", section: "Reference" },
  { src: "agent-hooks.md", out: "agent-hooks.html", navTitle: "Agent Hooks", section: "Reference" },
  { src: "flow-kit-container.md", out: "flow-kit-container.html", navTitle: "Flow Kit Container", section: "Reference" },
  { src: "project-config.md", out: "project-config.html", navTitle: "Project Config", section: "Reference" },
  { src: "release-readiness.md", out: "release-readiness.html", navTitle: "Release Readiness", section: "Reference" },
  { src: "product-vision.md", out: "product-vision.html", navTitle: "Product Vision", section: "Product" },
  { src: "developer-architecture.md", out: "developer-architecture.html", navTitle: "Developer Architecture", section: "Product" },
  { src: "contributing.md", out: "contributing.html", navTitle: "Contributing", section: "Project" },
  { src: "repo-structure.md", out: "repo-structure.html", navTitle: "Repo Structure", section: "Project" },
  { src: "adr/0001-flow-as-process-transparency-layer.md", out: "adr/0001-flow-as-process-transparency-layer.html", navTitle: "ADR 0001: Transparency Layer", section: "Decisions" },
  { src: "adr/0002-gate-expectations-and-project-authority.md", out: "adr/0002-gate-expectations-and-project-authority.html", navTitle: "ADR 0002: Gate Expectations", section: "Decisions" },
  { src: "adr/0003-project-config-merge-semantics.md", out: "adr/0003-project-config-merge-semantics.html", navTitle: "ADR 0003: Config Merge", section: "Decisions" }
];

const navSections: NavSection[] = ["Learn", "Reference", "Product", "Project", "Decisions"].map((title) => ({
  title,
  pages: pages.filter((page) => page.section === title)
}));

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/<[^>]*>/g, "")
    .replace(/&[a-z]+;|&#\d+;/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

// Pull fenced mermaid blocks out before markdown parsing so they render
// client-side instead of as code listings.
function extractMermaid(markdown: string): { markdown: string; hasMermaid: boolean } {
  let hasMermaid = false;
  const replaced = markdown.replace(/```mermaid\n([\s\S]*?)```/g, (_, body: string) => {
    hasMermaid = true;
    return `<pre class="mermaid">\n${escapeHtml(body)}</pre>`;
  });
  return { markdown: replaced, hasMermaid };
}

// Rewrite repo-relative markdown links into site or GitHub URLs.
function rewriteHref(href: string, pageDepth: number): string {
  if (/^(https?:|mailto:|#)/.test(href)) return href;
  const toRoot = "../".repeat(pageDepth);
  const [target, fragment = ""] = href.split("#");
  const hash = fragment ? `#${fragment}` : "";
  const normalized = path.posix.normalize(target);

  if (normalized === "../README.md" || normalized === "README.md") return `${toRoot}index.html${hash}`;
  if (normalized.startsWith("../")) {
    // Outside docs/: examples, schemas, LICENSE, CHANGELOG live on GitHub.
    return `${repoUrl}/blob/main/${normalized.slice(3)}${hash}`;
  }
  if (normalized.endsWith(".md")) return `${toRoot}${normalized.replace(/\.md$/, ".html")}${hash}`;
  if (normalized.startsWith("assets/")) return `${toRoot}${normalized}`;
  return href;
}

function rewriteLinks(html: string, pageDepth: number): string {
  return html.replace(/(href|src)="([^"]+)"/g, (_, attr: string, href: string) => {
    return `${attr}="${rewriteHref(href, pageDepth)}"`;
  });
}

function addHeadingAnchors(html: string): string {
  const seen = new Map<string, number>();
  return html.replace(/<h([1-4])>([\s\S]*?)<\/h\1>/g, (_, level: string, body: string) => {
    let slug = slugify(body);
    const count = seen.get(slug) ?? 0;
    seen.set(slug, count + 1);
    if (count > 0) slug = `${slug}-${count}`;
    return `<h${level} id="${slug}">${body}<a class="anchor" href="#${slug}" aria-label="Link to this section">#</a></h${level}>`;
  });
}

function wrapTables(html: string): string {
  return html.replaceAll("<table>", '<div class="table-scroll"><table>').replaceAll("</table>", "</table></div>");
}

function navHtml(activeOut: string, pageDepth: number): string {
  const toRoot = "../".repeat(pageDepth);
  const sections = navSections
    .map((section) => {
      const links = section.pages
        .map((page) => {
          const active = page.out === activeOut ? ' aria-current="page"' : "";
          return `<li><a href="${toRoot}${page.out}"${active}>${page.navTitle}</a></li>`;
        })
        .join("\n");
      return `<section class="nav-group">\n<h2>${section.title}</h2>\n<ul>\n${links}\n</ul>\n</section>`;
    })
    .join("\n");
  return sections;
}

function layout(options: {
  title: string;
  description: string;
  bodyClass: string;
  content: string;
  activeOut: string;
  pageDepth: number;
  hasMermaid: boolean;
}): string {
  const { title, description, bodyClass, content, activeOut, pageDepth, hasMermaid } = options;
  const toRoot = "../".repeat(pageDepth);
  const mermaidScript = hasMermaid
    ? `<script type="module">
import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";
const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
mermaid.initialize({ startOnLoad: true, theme: dark ? "dark" : "neutral" });
</script>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="description" content="${escapeHtml(description)}">
<meta name="theme-color" content="#0a0e13" media="(prefers-color-scheme: dark)">
<meta name="theme-color" content="#f5f4ef" media="(prefers-color-scheme: light)">
<title>${escapeHtml(title)}</title>
<meta property="og:type" content="website">
<meta property="og:site_name" content="Kontour Flow">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:image" content="${siteUrl}/assets/og-image.png">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeHtml(title)}">
<meta name="twitter:description" content="${escapeHtml(description)}">
<meta name="twitter:image" content="${siteUrl}/assets/og-image.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600&family=Hanken+Grotesk:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<link rel="stylesheet" href="${toRoot}styles.css">
<link rel="icon" href="${toRoot}favicon.svg" type="image/svg+xml">
</head>
<body class="${bodyClass}">
<a class="skip-link" href="#main">Skip to content</a>
<header class="site-header">
  <button class="nav-toggle" aria-expanded="false" aria-controls="site-nav" aria-label="Toggle navigation">
    <span></span><span></span><span></span>
  </button>
  <a class="brand" href="${toRoot}index.html">
    <span class="brand-mark" aria-hidden="true"></span>
    <span class="brand-name">Kontour <strong>Flow</strong></span>
    <span class="version-badge">v${pkg.version}</span>
  </a>
  <nav class="header-links" aria-label="Primary">
    <a href="${toRoot}getting-started.html">Docs</a>
    <a href="${repoUrl}" rel="noopener">GitHub</a>
    <a href="https://www.npmjs.com/package/@kontourai/flow" rel="noopener">npm</a>
  </nav>
</header>
<div class="shell">
  <nav id="site-nav" class="site-nav" aria-label="Documentation">
${navHtml(activeOut, pageDepth)}
  </nav>
  <div class="nav-backdrop" hidden></div>
  <main id="main" class="content">
${content}
  <footer class="site-footer">
    <p><strong>Kontour AI</strong> shows the work behind AI. Flow is the process transparency layer.</p>
    <p><a href="${repoUrl}" rel="noopener">GitHub</a> · <a href="https://www.npmjs.com/package/@kontourai/flow" rel="noopener">npm</a> · <a href="${repoUrl}/blob/main/LICENSE" rel="noopener">Apache-2.0</a></p>
  </footer>
  </main>
</div>
<script>
const toggle = document.querySelector(".nav-toggle");
const nav = document.getElementById("site-nav");
const backdrop = document.querySelector(".nav-backdrop");
function setNav(open) {
  toggle.setAttribute("aria-expanded", String(open));
  nav.classList.toggle("open", open);
  backdrop.hidden = !open;
  document.body.classList.toggle("nav-open", open);
}
toggle.addEventListener("click", () => setNav(toggle.getAttribute("aria-expanded") !== "true"));
backdrop.addEventListener("click", () => setNav(false));
window.matchMedia("(min-width: 960px)").addEventListener("change", () => setNav(false));
</script>
${mermaidScript}
</body>
</html>
`;
}

async function renderDocPage(page: PageDef): Promise<void> {
  const raw = await readFile(path.join(docsDir, page.src), "utf8");
  const { markdown, hasMermaid } = extractMermaid(raw);
  const pageDepth = page.out.split("/").length - 1;
  let html = await marked.parse(markdown, { gfm: true });
  html = rewriteLinks(html, pageDepth);
  html = addHeadingAnchors(html);
  html = wrapTables(html);
  const titleMatch = raw.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1] : page.navTitle;
  const description = `Kontour Flow documentation: ${title}.`;
  const output = layout({
    title: `${title} · Kontour Flow`,
    description,
    bodyClass: "doc-page",
    content: `<article class="doc">\n${html}\n</article>`,
    activeOut: page.out,
    pageDepth,
    hasMermaid
  });
  const target = path.join(outDir, page.out);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, output);
}

function landingContent(): string {
  return `
<section class="hero">
  <p class="hero-kicker">Kontour Flow · process transparency</p>
  <h1>Proof, not promises.</h1>
  <p class="hero-lede">AI agents skip steps, accept weak evidence, and summarize work as complete. Flow records the required path, the evidence each gate expected, and why the work was allowed to advance — in plain local files that survive context loss.</p>
  <div class="hero-actions">
    <a class="button primary" href="getting-started.html">Get started</a>
    <a class="button" href="use-cases.html">See use cases</a>
  </div>
  <pre class="hero-terminal"><code>$ flow status dev-1847

flow run: agent-dev-flow / feature-search-filters
current step: implement

<span class="t-pass">PASS</span>  plan gate: Acceptance criteria are ready for implementation. satisfied
<span class="t-wait">WAIT</span>  implementation gate: implementation gate waiting
<span class="t-wait">WAIT</span>  verify gate: verify gate waiting

next action: attach evidence for implementation gate
continuation: resume from implement, not chat memory</code></pre>
</section>

<section class="features">
  <h2>Why teams adopt Flow</h2>
  <div class="feature-grid">
    <div class="feature">
      <h3>Evidence-gated transitions</h3>
      <p>A step is not complete because an agent says so. Gates declare typed expectations, and runs advance only when evidence satisfies them — or a human accepts an explicit, attributable exception.</p>
    </div>
    <div class="feature">
      <h3>Survives context loss</h3>
      <p>Every run lives in plain files under <code>.flow/runs/</code>. A new agent session, a teammate, or a CI job can <code>flow resume</code> and continue from recorded state, not chat memory.</p>
    </div>
    <div class="feature">
      <h3>Deterministic route-back</h3>
      <p>Failed evidence routes work back to the right step with attempt budgets derived from persisted state, so agents cannot loop silently forever.</p>
    </div>
    <div class="feature">
      <h3>Audit-ready reports</h3>
      <p>Every run regenerates a human-readable <code>report.md</code> and machine-readable <code>report.json</code> explaining what passed, what blocked, what was excepted, and what happens next.</p>
    </div>
    <div class="feature">
      <h3>Local-first, zero lock-in</h3>
      <p>A file-backed CLI and typed TypeScript library. No hosted service, no account, no telemetry. Your evidence stays in your repo.</p>
    </div>
    <div class="feature">
      <h3>Built to compose</h3>
      <p><a href="https://kontourai.io/veritas" rel="noopener">Veritas</a> can supply repo-readiness evidence, <a href="https://kontourai.github.io/flow-agents/" rel="noopener">Flow Agents</a> can enforce gates from agent harnesses — and Flow stands alone without either.</p>
    </div>
  </div>
</section>

<section class="showcase">
  <h2>Watch the gate hold</h2>
  <p>Four commands: scaffold a demo run, check status, watch <code>flow evaluate --exit-code</code> refuse to pass without evidence, and resume from recorded state.</p>
  <img src="assets/flow-demo.gif" alt="Terminal recording of flow init --demo, status, a blocked evaluate, and resume" loading="lazy">
</section>

<section class="showcase">
  <h2>Inspect any run, locally</h2>
  <p>The bundled loopback-only console renders a run from its local files: process graph, transition timeline, gate outcomes, evidence, and the next action.</p>
  <img src="assets/flow-console-desktop.png" alt="Flow Console showing a run blocked at the verify step with gate details and evidence" loading="lazy">
</section>

<section class="quickstart">
  <h2>Sixty seconds to a gated run</h2>
  <pre><code>npm install -D @kontourai/flow

npx flow init
npx flow start .flow/definitions/agent-dev-flow.json \\
  --run-id dev-1847 --params subject=feature-search-filters
npx flow attach-evidence dev-1847 --gate plan-gate \\
  --file ./acceptance-claim.json --trust-artifact
npx flow evaluate dev-1847
npx flow resume dev-1847</code></pre>
  <p><a class="button primary" href="getting-started.html">Walk through it step by step</a></p>
</section>
`;
}

async function build(): Promise<void> {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  await cp(path.join(docsDir, "assets"), path.join(outDir, "assets"), { recursive: true });
  await cp(path.join(repoRoot, "scripts", "docs-site", "styles.css"), path.join(outDir, "styles.css"));
  await cp(path.join(repoRoot, "scripts", "docs-site", "favicon.svg"), path.join(outDir, "favicon.svg"));
  await writeFile(path.join(outDir, ".nojekyll"), "");

  for (const page of pages) await renderDocPage(page);

  const landing = layout({
    title: "Kontour Flow — process transparency for agentic work",
    description: "Flow records the required path, the evidence each gate expected, and why work was allowed to advance. Local-first CLI and TypeScript library.",
    bodyClass: "landing",
    content: landingContent(),
    activeOut: "index.html",
    pageDepth: 0,
    hasMermaid: false
  });
  await writeFile(path.join(outDir, "index.html"), landing);
  console.log(`built ${pages.length + 1} pages into ${path.relative(repoRoot, outDir)}/`);
}

await build();
