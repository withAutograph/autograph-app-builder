import { createRequire as createRequireImport } from "node:module";
import * as fsImport from "node:fs/promises";
import * as pathImport from "node:path";

const fs =
  /** @type {{ readFile: (path: string, encoding: string) => Promise<string>, readdir: (path: string) => Promise<string[]>, writeFile: (path: string, data: string) => Promise<void> }} */ (
    fsImport
  );
const path = /** @type {{ join: (...parts: string[]) => string }} */ (pathImport);
const createRequire = /** @type {(url: string) => { resolve: (name: string) => string }} */ (
  createRequireImport
);

const eagerAssets = `var FONTS = {
  "geist-sans.woff2": readFileSync(path.join(__dirname, "fonts", "geist-sans.woff2")),
  "GeistPixel-Square.woff2": readFileSync(path.join(__dirname, "fonts", "GeistPixel-Square.woff2"))
};
var FAVICON = readFileSync(path.join(__dirname, "fonts", "favicon.ico"));`;

const entrypoints = new Set();
const packages = ["github", "vercel"];
const resolvePackage = createRequire(import.meta.url).resolve;

for (const packageName of packages) {
  entrypoints.add(resolvePackage(`@emulators/${packageName}`));
}

// Vercel can restore both patched and original pnpm package directories from its
// build cache. Webpack may resolve the original physical directory even though
// pnpm's top-level link points at the patched copy, so prepare every installed
// copy before the application build starts.
const pnpmDirectories = await fs.readdir(path.join("node_modules", ".pnpm"));
for (const packageName of packages) {
  const prefix = `@emulators+${packageName}@0.10.0`;
  for (const directory of pnpmDirectories.filter((name) => name.startsWith(prefix))) {
    entrypoints.add(
      path.join(
        "node_modules",
        ".pnpm",
        directory,
        "node_modules",
        "@emulators",
        packageName,
        "dist",
        "index.js",
      ),
    );
  }
}

for (const entrypoint of entrypoints) {
  // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
  const source = await fs.readFile(entrypoint, "utf-8");
  if (!source.includes(eagerAssets)) continue;
  // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
  await fs.writeFile(entrypoint, source.replace(eagerAssets, ""));
}

console.log(`Prepared ${entrypoints.size} Emulate provider runtime entrypoints.`);
