import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const eagerAssets = `var FONTS = {
  "geist-sans.woff2": readFileSync(join(__dirname, "fonts", "geist-sans.woff2")),
  "GeistPixel-Square.woff2": readFileSync(join(__dirname, "fonts", "GeistPixel-Square.woff2"))
};
var FAVICON = readFileSync(join(__dirname, "fonts", "favicon.ico"));`;

for (const packageName of ["@emulators/github", "@emulators/vercel"]) {
  const entrypoint = fileURLToPath(import.meta.resolve(packageName));
  const source = await readFile(entrypoint, "utf8");
  if (!source.includes(eagerAssets)) continue;
  await writeFile(entrypoint, source.replace(eagerAssets, ""));
}
