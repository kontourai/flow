/**
 * Hachure trust-bundle schema validation.
 *
 * Uses the normative trust-bundle.schema.json shipped by the `hachure` package.
 * Sub-schemas (claim.schema.json, evidence.schema.json, etc.) are loaded from
 * the same schemas directory and added to the Ajv instance so $ref resolution
 * works without HTTP access.
 */
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Ajv 8 ships as CommonJS; import via createRequire to avoid type-level issues.
// Use the 2020 draft validator since Hachure schemas use JSON Schema 2020-12.
const _require = createRequire(import.meta.url);
const Ajv = _require("ajv/dist/2020");

// Resolve hachure dir from its main entry (package.json is not exported)
const hachureDir = dirname(_require.resolve("hachure"));
const schemasDir = join(hachureDir, "schemas");

function loadHachureSchemas(): Record<string, any> {
  const schemas: Record<string, any> = {};
  for (const file of readdirSync(schemasDir)) {
    if (!file.endsWith(".schema.json")) continue;
    const content = readFileSync(join(schemasDir, file), "utf8");
    schemas[file] = JSON.parse(content);
  }
  return schemas;
}

let _validate: ((data: unknown) => boolean) | null = null;

function getValidator() {
  if (_validate) return _validate;

  const hachureSchemas = loadHachureSchemas();
  const ajv = new Ajv({ strict: false, allErrors: true });

  // Add all sub-schemas so $ref can resolve locally
  for (const [filename, schema] of Object.entries(hachureSchemas)) {
    if (filename === "trust-bundle.schema.json") continue;
    ajv.addSchema(schema, filename);
  }

  const trustBundleSchema = hachureSchemas["trust-bundle.schema.json"];
  if (!trustBundleSchema) throw new Error("hachure trust-bundle.schema.json not found");
  _validate = ajv.compile(trustBundleSchema);
  return _validate;
}

export interface TrustBundleValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateTrustBundleSchema(bundle: unknown): TrustBundleValidationResult {
  try {
    const validate = getValidator();
    const valid = validate(bundle);
    if (valid) return { valid: true, errors: [] };
    const errors = ((validate as any).errors ?? []).map((err: any) => {
      const loc = err.instancePath || err.schemaPath || "";
      return `${loc} ${err.message ?? "invalid"}`.trim();
    });
    return { valid: false, errors };
  } catch (err: any) {
    return { valid: false, errors: [`validator error: ${err?.message ?? String(err)}`] };
  }
}
