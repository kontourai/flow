import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { moduleRoot } from "./flow-files.js";

const require = createRequire(import.meta.url);
const Ajv = require("ajv/dist/2020");
const addFormats = require("ajv-formats");

let validateState: any;
let validateManifest: any;

function compileSchema(fileName: string) {
  const schemaPath = path.join(moduleRoot(), "schemas", fileName);
  const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  return ajv.compile(schema);
}

function stateValidator() {
  if (validateState) return validateState;
  validateState = compileSchema("flow-run.schema.json");
  return validateState;
}

function manifestValidator() {
  if (validateManifest) return validateManifest;
  validateManifest = compileSchema("gate-evidence.schema.json");
  return validateManifest;
}

function schemaError(validate: any, contract: string) {
  const details = (validate.errors ?? [])
    .slice(0, 5)
    .map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`)
    .join("; ");
  return new Error(`${contract}: ${details}`);
}

export function validateRunStateSchema(state: unknown) {
  const validate = stateValidator();
  if (validate(state)) return state;
  throw schemaError(validate, "run state does not satisfy flow-run.schema.json");
}

export function validateEvidenceManifestSchema(manifest: unknown) {
  const validate = manifestValidator();
  if (validate(manifest)) return manifest;
  throw schemaError(validate, "evidence manifest does not satisfy gate-evidence.schema.json");
}
