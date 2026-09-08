import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const eagerAssets = `var FONTS = {
  "geist-sans.woff2": readFileSync(join(__dirname, "fonts", "geist-sans.woff2")),
  "GeistPixel-Square.woff2": readFileSync(join(__dirname, "fonts", "GeistPixel-Square.woff2"))
};
var FAVICON = readFileSync(join(__dirname, "fonts", "favicon.ico"));`;

const entrypoints = new Set();
const packages = ["github", "vercel"];

for (const packageName of packages) {
  entrypoints.add(
    fileURLToPath(import.meta.resolve(`@emulators/${packageName}`)),
  );
}

// Vercel can restore both patched and original pnpm package directories from its
// build cache. Webpack may resolve the original physical directory even though
// pnpm's top-level link points at the patched copy, so prepare every installed
// copy before the application build starts.
const pnpmDirectories = await readdir(join("node_modules", ".pnpm"));
for (const packageName of packages) {
  const prefix = `@emulators+${packageName}@0.10.0`;
  for (const directory of pnpmDirectories.filter((name) =>
    name.startsWith(prefix),
  )) {
    entrypoints.add(
      join(
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
  const source = await readFile(entrypoint, "utf8");
  if (!source.includes(eagerAssets)) continue;
  await writeFile(entrypoint, source.replace(eagerAssets, ""));
}

console.log(
  `Prepared ${entrypoints.size} Emulate provider runtime entrypoints.`,
);
