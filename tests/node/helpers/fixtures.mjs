import { readFile } from "node:fs/promises";

export async function json(file) {
  return JSON.parse(await readFile(new URL(`../../../${file}`, import.meta.url), "utf8"));
}

export async function surfaceClaimFixture(file) {
  return json(`examples/scenarios/surface-claims/${file}`);
}

export async function surfaceClaimEvidenceFixture(file) {
  return surfaceClaimFixture(`evidence/${file}`);
}

export async function releaseReadinessFixture(file) {
  return json(`examples/scenarios/release-readiness/${file}`);
}

export async function versionReleaseReportFixture(file) {
  return json(`examples/scenarios/version-release-report/${file}`);
}

export async function resourceDefinitionFixture() {
  return json("examples/flow-definition-resource-contract.json");
}

export function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
