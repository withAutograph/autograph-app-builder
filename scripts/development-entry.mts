import { lstat, mkdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

import { runWithDevelopmentLock } from "../lib/development/advisory-lock";
import { parseDevelopmentArguments } from "../lib/development/local-mode";

const repositoryRoot = resolve(".");

async function privateRoot(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const canonical = await realpath(path);
  const info = await lstat(canonical);
  if (
    canonical !== path ||
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o077) !== 0
  )
    throw new Error(
      `Development root must be canonical, owner-only, and mode 0700: ${path}`,
    );
  return canonical;
}

if (
  process.env.VERCEL_TOKEN !== undefined ||
  process.env.AI_GATEWAY_API_KEY !== undefined
)
  throw new Error(
    "Development mode rejects static Vercel and AI Gateway credentials.",
  );

const args = parseDevelopmentArguments(process.argv.slice(2));
const artifactRoot = await privateRoot(
  args.stateRoot ?? join(repositoryRoot, ".artifacts/development"),
);
const node = process.env.APP_BUILDER_DEV_NODE_BIN;
if (node === undefined || !node.startsWith("/"))
  throw new Error("mise must supply the absolute development Node executable.");

const code = await runWithDevelopmentLock({
  lockPath: join(artifactRoot, "development.lock"),
  command: node,
  args: [
    "--import",
    "tsx",
    join(repositoryRoot, "scripts/development.mts"),
    ...process.argv.slice(2),
  ],
  environment: process.env,
});
process.exitCode = code;
