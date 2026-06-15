import { cp, lstat, mkdir, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const kitRoot = path.join(root, "node_modules", "@kontourai", "ui");
const vendorRoot = path.join(root, "src", "console-ui", "vendor", "ui");
const checkOnly = process.argv.includes("--check");

const assets = [
  {
    label: "tokens",
    source: path.join(kitRoot, "tokens"),
    target: path.join(vendorRoot, "tokens"),
    directory: true,
  },
  {
    label: "react styles",
    source: path.join(kitRoot, "react", "styles.css"),
    target: path.join(vendorRoot, "react", "styles.css"),
    directory: false,
  },
  {
    label: "flow product mark",
    source: path.join(kitRoot, "icons", "flow.svg"),
    target: path.join(vendorRoot, "icons", "flow.svg"),
    directory: false,
  },
];

if (checkOnly) {
  await assertSynced();
  console.log("Flow UI vendor assets are synced.");
} else {
  await syncAssets();
  console.log("Synced Flow UI vendor assets.");
}

async function syncAssets() {
  await assertPackageInstalled();
  await rm(vendorRoot, { recursive: true, force: true });
  await mkdir(path.join(vendorRoot, "react"), { recursive: true });
  await mkdir(path.join(vendorRoot, "icons"), { recursive: true });

  for (const asset of assets) {
    await cp(asset.source, asset.target, { recursive: asset.directory });
  }
}

async function assertSynced() {
  await assertPackageInstalled();

  for (const asset of assets) {
    const sourceStat = await lstat(asset.source);
    const targetStat = await lstat(asset.target);

    if (targetStat.isSymbolicLink()) {
      throw new Error(`Vendor asset must not be a symlink: ${asset.target}`);
    }

    if (asset.directory) {
      if (!sourceStat.isDirectory() || !targetStat.isDirectory()) {
        throw new Error(`Expected directory asset for ${asset.label}.`);
      }
      await compareDirectories(asset.source, asset.target);
    } else {
      if (!sourceStat.isFile() || !targetStat.isFile()) {
        throw new Error(`Expected file asset for ${asset.label}.`);
      }
      await compareFiles(asset.source, asset.target);
    }
  }
}

async function assertPackageInstalled() {
  const stat = await lstat(kitRoot).catch(() => undefined);
  if (!stat) {
    throw new Error("Missing @kontourai/ui. Run npm install from the flow package.");
  }
}

async function compareDirectories(source, target) {
  const sourceEntries = await readdir(source, { withFileTypes: true });
  const targetEntries = await readdir(target, { withFileTypes: true });
  const sourceNames = sourceEntries.map((entry) => entry.name).sort();
  const targetNames = targetEntries.map((entry) => entry.name).sort();
  const targetByName = new Map(targetEntries.map((entry) => [entry.name, entry]));

  if (sourceNames.join("\0") !== targetNames.join("\0")) {
    throw new Error(`Vendor directory drifted: ${target}`);
  }

  for (const entry of sourceEntries) {
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);
    const targetEntry = targetByName.get(entry.name);
    if (!targetEntry || targetEntry.isSymbolicLink()) {
      throw new Error(`Vendor asset must not be a symlink: ${targetPath}`);
    }
    if (entry.isDirectory()) {
      if (!targetEntry.isDirectory()) {
        throw new Error(`Expected directory asset: ${targetPath}`);
      }
      await compareDirectories(sourcePath, targetPath);
    } else if (entry.isFile()) {
      if (!targetEntry.isFile()) {
        throw new Error(`Expected file asset: ${targetPath}`);
      }
      await compareFiles(sourcePath, targetPath);
    }
  }
}

async function compareFiles(source, target) {
  const [sourceContent, targetContent] = await Promise.all([readFile(source), readFile(target)]);
  if (!sourceContent.equals(targetContent)) {
    throw new Error(`Vendor file drifted: ${target}`);
  }
}
