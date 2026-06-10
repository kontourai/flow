import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const publicEntrypoints = ["."];

const publicImports = [
  {
    specifier: "@kontourai/flow",
    exportName: "validateDefinition"
  }
];

const internalImports = [
  "@kontourai/flow/console-projection",
  "@kontourai/flow/console-server",
  "@kontourai/flow/flow-files",
  "@kontourai/flow/dist/console-projection.js",
  "@kontourai/flow/dist/console-server.js",
  "@kontourai/flow/dist/flow-files.js",
  "@kontourai/flow/dist/runtime/flow-files.js",
  "@kontourai/flow/dist/console/console-projection.js",
  "@kontourai/flow/dist/console/console-server.js"
];

async function readPackageJson() {
  return JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
}

test("package exports declare exactly the public consumer entrypoints", async () => {
  const packageJson = await readPackageJson();

  assert.deepEqual(Object.keys(packageJson.exports).sort(), publicEntrypoints.sort());
  assert.equal(packageJson.exports["."].import, "./dist/index.js");
});

test("public package entrypoints import successfully as package specifiers", async () => {
  for (const publicImport of publicImports) {
    const module = await import(publicImport.specifier);
    assert.equal(
      typeof module[publicImport.exportName],
      "function",
      `${publicImport.specifier} must export ${publicImport.exportName}`
    );
  }
});

test("representative implementation subpaths are blocked by package exports", async () => {
  for (const specifier of internalImports) {
    await assert.rejects(
      import(specifier),
      (error) => {
        assert.equal(error.code, "ERR_PACKAGE_PATH_NOT_EXPORTED");
        assert.match(error.message, /Package subpath/);
        return true;
      },
      `${specifier} must not be importable as a package subpath`
    );
  }
});
