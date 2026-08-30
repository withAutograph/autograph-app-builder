import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

if (
  process.env.VERCEL_ENV !== "preview" ||
  process.env.APP_BUILDER_PREVIEW_PROVIDER_EMULATION !== "1"
) {
  process.exit(0);
}

const require = createRequire(import.meta.url);
const eagerAssets = `var FONTS = {
  "geist-sans.woff2": readFileSync(join(__dirname, "fonts", "geist-sans.woff2")),
  "GeistPixel-Square.woff2": readFileSync(join(__dirname, "fonts", "GeistPixel-Square.woff2"))
};
var FAVICON = readFileSync(join(__dirname, "fonts", "favicon.ico"));`;

for (const packageName of ["@emulators/github", "@emulators/vercel"]) {
  const packageRoot = dirname(require.resolve(`${packageName}/package.json`));
  const entrypoint = join(packageRoot, "dist", "index.js");
  const source = await readFile(entrypoint, "utf8");
  if (!source.includes(eagerAssets)) continue;
  await writeFile(entrypoint, source.replace(eagerAssets, ""));
}
