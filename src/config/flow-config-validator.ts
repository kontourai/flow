import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { types } from "node:util";
import path from "node:path";

import { moduleRoot } from "../runtime/flow-files.js";

const require = createRequire(import.meta.url);
const Ajv = require("ajv/dist/2020");

let validateFlatConfig: any;

/**
 * Shared bounds for every caller-owned project-config graph. These reuse
 * Flow's established 4,096-record structural budget and its 4,096-character
 * bounded text convention; conflict paths reuse the 2,048-character request
 * reference ceiling.
 */
export const FLOW_CONFIG_INPUT_LIMITS = Object.freeze({
  depth: 256,
  nodes: 4_096,
  properties: 4_096,
  arrayLength: 4_096,
  stringLength: 4_096,
  conflictPaths: 1_024,
  conflictPathLength: 2_048
});

class ConfigInputInvalidError extends Error {
  constructor() {
    super("flow.config.input.invalid: config input must be a bounded acyclic JSON value");
  }
}

function configInputInvalidError() {
  return new ConfigInputInvalidError();
}

/**
 * Materialize caller-owned config into a plain JSON-shaped tree before any
 * normalization, cloning, or schema validation. Array lengths are checked
 * before element reads; Proxy and non-plain containers are rejected before
 * enumeration; and one aggregate work budget covers every object property
 * and array slot. Repeated object identities are rejected alongside cycles.
 */
export function snapshotFlowConfigInput(input: unknown): unknown {
  const stack: Array<{ value: unknown; depth: number; assign: (snapshot: unknown) => void }> = [{ value: input, depth: 0, assign: (snapshot) => { result = snapshot; } }];
  const visited = new WeakSet<object>();
  let nodes = 0;
  let work = 0;
  let result: unknown;

  try {
    while (stack.length) {
      const { value, depth, assign } = stack.pop()!;
      if (typeof value === "string") {
        if (value.length > FLOW_CONFIG_INPUT_LIMITS.stringLength) throw configInputInvalidError();
        assign(value);
        continue;
      }
      if (value === null || typeof value === "boolean" || typeof value === "number") {
        assign(value);
        continue;
      }
      if (typeof value !== "object") throw configInputInvalidError();
      if (depth > FLOW_CONFIG_INPUT_LIMITS.depth || visited.has(value)) throw configInputInvalidError();
      if (types.isProxy(value)) throw configInputInvalidError();
      visited.add(value);
      nodes += 1;
      if (nodes > FLOW_CONFIG_INPUT_LIMITS.nodes) throw configInputInvalidError();

      const array = Array.isArray(value);
      const prototype = Object.getPrototypeOf(value);
      if ((array && prototype !== Array.prototype) || (!array && prototype !== Object.prototype && prototype !== null)) {
        throw configInputInvalidError();
      }
      if (array) {
        const length = value.length;
        if (!Number.isSafeInteger(length) || length < 0 || length > FLOW_CONFIG_INPUT_LIMITS.arrayLength) throw configInputInvalidError();
        work += length;
        if (work > FLOW_CONFIG_INPUT_LIMITS.properties) throw configInputInvalidError();
        const snapshot = new Array(length);
        assign(snapshot);
        for (let index = length - 1; index >= 0; index -= 1) {
          const entry = value[index];
          stack.push({ value: entry, depth: depth + 1, assign: (child) => { snapshot[index] = child; } });
        }
        continue;
      }

      const snapshot: Record<string, unknown> = Object.create(null);
      assign(snapshot);
      const entries: Array<[string, unknown]> = [];
      for (const key in value as Record<string, unknown>) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
        work += 1;
        if (work > FLOW_CONFIG_INPUT_LIMITS.properties || key.length > FLOW_CONFIG_INPUT_LIMITS.stringLength) throw configInputInvalidError();
        entries.push([key, (value as Record<string, unknown>)[key]]);
      }
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const [key, entry] = entries[index];
        stack.push({ value: entry, depth: depth + 1, assign: (child) => { snapshot[key] = child; } });
      }
    }
    return result;
  } catch {
    throw configInputInvalidError();
  }
}

function legacyAuthorityTracesTraversalError() {
  return new Error("flow.config.input.invalid: config input must be a bounded acyclic JSON value");
}

function rejectLegacyAuthorityTraces(value: unknown, path = "$"): void {
  const stack: Array<{ value: unknown; path: string; depth: number }> = [{ value, path, depth: 0 }];
  const visited = new WeakSet<object>();
  let visitedNodes = 0;
  while (stack.length) {
    const current = stack.pop()!;
    if (!current.value || typeof current.value !== "object" || Array.isArray(current.value)) continue;
    if (visited.has(current.value)) continue;
    visited.add(current.value);
    visitedNodes += 1;
    if (visitedNodes > FLOW_CONFIG_INPUT_LIMITS.nodes || current.depth > FLOW_CONFIG_INPUT_LIMITS.depth) {
      throw legacyAuthorityTracesTraversalError();
    }
    for (const [key, entry] of Object.entries(current.value as Record<string, unknown>)) {
      if (key === "authority_traces") {
        throw new Error(`flow config ${current.path}.${key} is removed; migrate its authority references to authority_refs`);
      }
      stack.push({ value: entry, path: `${current.path}.${key}`, depth: current.depth + 1 });
    }
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
  const snapshot = snapshotFlowConfigInput(config);
  rejectLegacyAuthorityTraces(snapshot);
  const validate = flatConfigValidator();
  if (validate(snapshot)) return snapshot;
  throw schemaError(validate);
}
