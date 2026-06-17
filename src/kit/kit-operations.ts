import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { tmpdir } from "node:os";
import { validateKitContainerFile } from "./flow-kit-container.js";

export type { KitContainerDiagnostic, KitContainerValidationResult } from "./flow-kit-container.js";

const execFile = promisify(execFileCallback);

// A clone into a fresh temp dir must not inherit an ambient git context
// (GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE / ...). When `flow kit install` runs
// inside a git hook those vars are exported and would redirect the clone onto
// the caller's repo. Scrub them for git subprocesses.
function gitCleanEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))
  );
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type KitInstallSource =
  | { kind: "local"; dirPath: string }
  | { kind: "git"; url: string; ref?: string }
  | { kind: "npm"; spec: string };

export interface KitInstallOptions {
  /** Destination directory where the kit package will be placed (default: current directory). */
  dest?: string;
  /** Git ref (branch/tag/sha) — overrides any #ref in the URL. */
  ref?: string;
}

export interface KitInstallResult {
  installed: boolean;
  kitId: string;
  destPath: string;
}

export interface KitInspectResult {
  valid: boolean;
  /** Structural view only — does not interpret extension semantics. */
  flows: Array<{ id?: string; path: string }>;
  /**
   * Names of declared asset-class keys present in kit.json beyond the core
   * fields (schema_version, id, name, flows, description, product_name).
   * Example: ["skills", "docs", "adapters"]. Flow does NOT interpret what
   * these mean — that is flow-agents' responsibility. No K-levels or runtime
   * targets are derived here.
   */
  assetClasses: string[];
  kitId?: string;
  kitName?: string;
  diagnostics: Array<{ code: string; severity: string; path: string; message: string }>;
}

// ---------------------------------------------------------------------------
// Source parsing
// ---------------------------------------------------------------------------

const CORE_KIT_FIELDS = new Set([
  "schema_version", "id", "name", "flows", "description", "product_name"
]);

/**
 * Parse a source string into a typed KitInstallSource.
 * - Strings starting with http://, https://, git+, ssh://, or ending with .git → git
 * - Strings starting with file:// → git (local git clone) or local path
 * - Strings with / or . prefix → local path
 * - Everything else → npm spec
 */
export function parseKitSource(source: string, refOverride?: string): KitInstallSource {
  // file:// → treat as local directory path
  if (source.startsWith("file://")) {
    const filePath = source.slice(7);
    // If it looks like a git repo (has .git suffix or contains #ref), treat as git
    if (source.includes("#") || source.endsWith(".git")) {
      const [url, hashRef] = source.split("#");
      return { kind: "git", url, ref: refOverride ?? hashRef };
    }
    return { kind: "local", dirPath: filePath };
  }

  // git remote URLs
  if (
    source.startsWith("https://") ||
    source.startsWith("http://") ||
    source.startsWith("git+") ||
    source.startsWith("ssh://") ||
    source.startsWith("git@")
  ) {
    const [url, hashRef] = source.split("#");
    return { kind: "git", url, ref: refOverride ?? hashRef };
  }

  // Local path: starts with /, ./, ../, or ~ or is a relative path with known separators
  if (
    source.startsWith("/") ||
    source.startsWith("./") ||
    source.startsWith("../") ||
    source.startsWith("~")
  ) {
    return { kind: "local", dirPath: source };
  }

  // npm spec (package name, possibly with @version)
  return { kind: "npm", spec: source };
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

/**
 * Fetch a kit from a git URL, npm spec, or local path; validate the container;
 * and place the kit package at dest.
 *
 * AGENT-BLIND: copies the whole kit package as-is. Does not interpret or
 * filter by asset class — that is flow-agents' responsibility.
 */
export async function kitInstall(
  source: string,
  options: KitInstallOptions = {}
): Promise<KitInstallResult> {
  const parsed = parseKitSource(source, options.ref);
  const destBase = options.dest ?? process.cwd();

  let kitDir: string;
  let tempDir: string | undefined;

  if (parsed.kind === "local") {
    kitDir = path.resolve(parsed.dirPath);
    if (!existsSync(kitDir)) {
      throw new Error(`kit source path does not exist: ${kitDir}`);
    }
  } else if (parsed.kind === "git") {
    tempDir = await mkdtemp(path.join(tmpdir(), "flow-kit-install-git-"));
    const cloneArgs = ["clone", "--depth", "1"];
    if (parsed.ref) cloneArgs.push("--branch", parsed.ref);
    cloneArgs.push(parsed.url, tempDir);
    await execFile("git", cloneArgs, { env: gitCleanEnv() });
    kitDir = tempDir;
  } else {
    // npm
    tempDir = await mkdtemp(path.join(tmpdir(), "flow-kit-install-npm-"));
    await execFile("npm", ["pack", parsed.spec, "--json", "--pack-destination", tempDir]);
    // npm pack extracts to a tgz; we need to extract it
    const tgzFiles = (await import("node:fs/promises")).readdir(tempDir);
    const [tgz] = await tgzFiles;
    const extractDir = path.join(tempDir, "package");
    await mkdir(extractDir, { recursive: true });
    await execFile("tar", ["xzf", path.join(tempDir, tgz), "-C", extractDir, "--strip-components", "1"]);
    kitDir = extractDir;
  }

  try {
    // Validate the container (agent-blind: only checks core fields + path existence)
    const validation = await validateKitContainerFile(kitDir);
    if (!validation.valid) {
      const errors = validation.diagnostics
        .filter((d) => d.severity === "error")
        .map((d) => `${d.code} ${d.path}: ${d.message}`)
        .join("\n  ");
      throw new Error(`kit container validation failed:\n  ${errors}`);
    }

    const manifest = JSON.parse(
      await readFile(path.join(kitDir, "kit.json"), "utf8")
    ) as Record<string, unknown>;
    const kitId = manifest.id as string;

    const destPath = path.resolve(destBase, kitId);

    // Copy the whole kit package as-is — agent-blind, no filtering by asset class
    await cp(kitDir, destPath, { recursive: true });

    return { installed: true, kitId, destPath };
  } finally {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
}

// ---------------------------------------------------------------------------
// Inspect
// ---------------------------------------------------------------------------

/**
 * Report the STRUCTURAL view of a kit container: validity, flow ids, and
 * the NAMES of declared asset classes.
 *
 * AGENT-BLIND: lists names of extension fields (skills, docs, adapters, etc.)
 * without interpreting what they mean. Does NOT derive K-levels or runtime
 * targets — that is flow-agents' responsibility.
 */
export async function kitInspect(kitDir: string): Promise<KitInspectResult> {
  const validation = await validateKitContainerFile(kitDir);

  if (!validation.valid) {
    return {
      valid: false,
      flows: [],
      assetClasses: [],
      diagnostics: validation.diagnostics
    };
  }

  const manifest = JSON.parse(
    await readFile(path.join(kitDir, "kit.json"), "utf8")
  ) as Record<string, unknown>;

  const flows = (manifest.flows as Array<Record<string, unknown>>).map((e) => ({
    id: typeof e.id === "string" ? e.id : undefined,
    path: e.path as string
  }));

  // Structural view only: list NAMES of extension fields present in kit.json.
  // Does NOT interpret what they mean (no K-level inference, no runtime targets).
  const assetClasses = Object.keys(manifest).filter(
    (k) => !CORE_KIT_FIELDS.has(k) && Array.isArray(manifest[k])
  );

  return {
    valid: true,
    flows,
    assetClasses,
    kitId: manifest.id as string,
    kitName: manifest.name as string,
    diagnostics: []
  };
}
