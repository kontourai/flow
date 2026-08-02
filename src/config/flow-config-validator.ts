import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { moduleRoot } from "../runtime/flow-files.js";

const require = createRequire(import.meta.url);
const Ajv = require("ajv/dist/2020");

let validateFlatConfig: any;

function rejectLegacyAuthorityTraces(value: unknown, path = "$"): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (key === "authority_traces") {
      throw new Error(`flow config ${path}.${key} is removed; migrate its authority references to authority_refs`);
    }
    rejectLegacyAuthorityTraces(entry, `${path}.${key}`);
  }
}

function flatConfigValidator() {
  if (validateFlatConfig) return validateFlatConfig;
  const schemaPath = path.join(moduleRoot(), "schemas", "flow-config.schema.json");
  const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
  const ajv = new Ajv({ strict: false, allErrors: true });
  ajv.addSchema(schema);
  validateFlatConfig = ajv.getSchema(`${schema.$id}#/$defs/flat_config`);
  if (!validateFlatConfig) throw new Error("flow config schema does not expose $defs.flat_config");
  return validateFlatConfig;
}

function schemaError(validate: any) {
  const details = (validate.errors ?? [])
    .slice(0, 5)
    .map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`)
    .join("; ");
  return new Error(`flow config does not satisfy flow-config.schema.json: ${details}`);
}

/** Validate the normalized, flat runtime config used by every evaluator. */
export function validateFlatFlowConfig(config: unknown) {
  rejectLegacyAuthorityTraces(config);
  const validate = flatConfigValidator();
  if (validate(config)) return config;
  throw schemaError(validate);
}
