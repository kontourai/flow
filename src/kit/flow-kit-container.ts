import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

export type KitContainerDiagnostic = {
  code: string;
  severity: "error" | "warning";
  path: string;
  message: string;
};

export type KitContainerValidationResult = {
  valid: boolean;
  diagnostics: KitContainerDiagnostic[];
};

function diag(
  code: string,
  jsonPath: string,
  message: string
): KitContainerDiagnostic {
  return { code, severity: "error", path: jsonPath, message };
}

/**
 * Validate a Flow Kit container manifest (kit.json) at the given kit root directory.
 *
 * Core validation enforces:
 * - kit.json exists and is valid JSON
 * - schema_version is "1.0"
 * - id matches ^[a-z][a-z0-9-]*$
 * - name is a non-empty string
 * - flows is a non-empty array
 * - each flows entry has a path that is relative, contains no '..', and points at an existing file
 *
 * Unknown top-level fields are consumer extensions and are ignored without error.
 */
export function validateKitContainer(
  kitDir: string,
  manifest: unknown
): KitContainerValidationResult {
  const diagnostics: KitContainerDiagnostic[] = [];

  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
    diagnostics.push(diag("kit.manifest.type", "$", "kit.json must be a JSON object"));
    return { valid: false, diagnostics };
  }

  const m = manifest as Record<string, unknown>;

  if (m.schema_version !== "1.0") {
    diagnostics.push(
      diag(
        "kit.schema_version.invalid",
        "$.schema_version",
        `.schema_version must be "1.0"`
      )
    );
  }

  if (typeof m.id !== "string" || !/^[a-z][a-z0-9-]*$/.test(m.id)) {
    diagnostics.push(
      diag(
        "kit.id.invalid",
        "$.id",
        `.id must be a kebab-case string matching ^[a-z][a-z0-9-]*$ (e.g. "review-kit")`
      )
    );
  }

  if (typeof m.name !== "string" || !m.name.trim()) {
    diagnostics.push(
      diag("kit.name.invalid", "$.name", ".name must be a non-empty string")
    );
  }

  if (!Array.isArray(m.flows) || m.flows.length === 0) {
    diagnostics.push(
      diag(
        "kit.flows.required",
        "$.flows",
        ".flows must be a non-empty array; declare at least one Flow Definition"
      )
    );
  } else {
    const flows = m.flows as unknown[];
    const seenPaths = new Set<string>();
    flows.forEach((entry, index) => {
      const jsonBase = `$.flows[${index}]`;
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        diagnostics.push(
          diag("kit.flows.entry.type", jsonBase, `flows[${index}] must be an object`)
        );
        return;
      }
      const e = entry as Record<string, unknown>;
      const rel = e.path;
      if (typeof rel !== "string" || !rel.trim()) {
        diagnostics.push(
          diag(
            "kit.flows.entry.path.required",
            `${jsonBase}.path`,
            `flows[${index}].path must be a non-empty string`
          )
        );
        return;
      }
      if (path.isAbsolute(rel)) {
        diagnostics.push(
          diag(
            "kit.flows.entry.path.absolute",
            `${jsonBase}.path`,
            `flows[${index}].path must be relative, not absolute: ${rel}`
          )
        );
        return;
      }
      const parts = rel.split(/[\\/]/);
      if (parts.includes("..")) {
        diagnostics.push(
          diag(
            "kit.flows.entry.path.traversal",
            `${jsonBase}.path`,
            `flows[${index}].path must not contain '..': ${rel}`
          )
        );
        return;
      }
      const resolved = path.resolve(kitDir, rel);
      const root = path.resolve(kitDir);
      if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
        diagnostics.push(
          diag(
            "kit.flows.entry.path.outside",
            `${jsonBase}.path`,
            `flows[${index}].path must resolve inside the kit directory: ${rel}`
          )
        );
        return;
      }
      if (seenPaths.has(rel)) {
        diagnostics.push(
          diag(
            "kit.flows.entry.path.duplicate",
            `${jsonBase}.path`,
            `flows[${index}].path duplicates an earlier entry: ${rel}`
          )
        );
        return;
      }
      seenPaths.add(rel);
      if (!existsSync(resolved)) {
        diagnostics.push(
          diag(
            "kit.flows.entry.path.missing",
            `${jsonBase}.path`,
            `flows[${index}].path points at missing Flow Definition: ${rel}`
          )
        );
      }
    });
  }

  return { valid: diagnostics.length === 0, diagnostics };
}

export async function validateKitContainerFile(
  kitDir: string
): Promise<KitContainerValidationResult & { manifestPath: string }> {
  const manifestPath = path.join(kitDir, "kit.json");
  let manifest: unknown;
  try {
    const text = await readFile(manifestPath, "utf8");
    manifest = JSON.parse(text);
  } catch (error) {
    const isJson = error instanceof SyntaxError;
    return {
      valid: false,
      manifestPath,
      diagnostics: [
        diag(
          isJson ? "kit.manifest.json.invalid" : "kit.manifest.read_failed",
          "$",
          `unable to read kit.json at ${manifestPath}: ${(error as Error).message}`
        )
      ]
    };
  }
  const result = validateKitContainer(kitDir, manifest);
  return { ...result, manifestPath };
}
