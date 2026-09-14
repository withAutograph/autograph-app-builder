import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";

import { runWithDevelopmentLock } from "../lib/development/advisory-lock";
import { parseDevelopmentArguments } from "../lib/development/local-mode";

const repositoryRoot = path.resolve(".");

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
async function privateRoot(root: string) {
  await mkdir(root, { mode: 0o700, recursive: true });
  const canonical = await realpath(root);
  const info = await lstat(canonical);
  if (
    canonical !== root ||
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    // oxlint-disable-next-line eslint/no-bitwise -- Intentional bitmask or binary-flag operation.
    (info.mode & 0o077) !== 0
  )
    {throw new Error(`Development root must be canonical, owner-only, and mode 0700: ${root}`);}
  return canonical;
}

if (process.env.VERCEL_TOKEN !== undefined || process.env.AI_GATEWAY_API_KEY !== undefined)
  {throw new Error("Development mode rejects static Vercel and AI Gateway credentials.");}

const args = parseDevelopmentArguments(process.argv.slice(2));
const artifactRoot = await privateRoot(
  args.stateRoot ?? path.join(repositoryRoot, ".artifacts/development"),
);
const node = process.env.APP_BUILDER_DEV_NODE_BIN;
if (node === undefined || !node.startsWith("/"))
  {throw new Error("mise must supply the absolute development Node executable.");}

const code = await runWithDevelopmentLock({
  args: [
    "--import",
    "tsx",
    path.join(repositoryRoot, "scripts/development.mts"),
    ...process.argv.slice(2),
  ],
  command: node,
  environment: process.env,
  lockPath: path.join(artifactRoot, "development.lock"),
});
process.exitCode = code;
