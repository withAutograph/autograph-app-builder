import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";

import { z } from "zod";

import { verifyPortableProofArtifact } from "./portable-proof-artifact";
import { releaseEndpoint, TOOL_NAMES } from "./portable-release";

const hash = z.string().regex(/^[0-9a-f]{64}$/u);
const gitObject = z.string().regex(/^[0-9a-f]{40}$/u);

const option = (name: string) => {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Missing ${name}.`);
  if (process.argv.indexOf(name, index + 1) >= 0)
    throw new Error(`Duplicate ${name}.`);
  return value;
};

const repositoryRoot = await realpath(resolve("."));
const outputInput = option("--output");
const endpoint = `${releaseEndpoint(option("--endpoint"))}/mcp`;
const deploymentUrl = new URL(option("--deployment-url"));
if (
  deploymentUrl.protocol !== "https:" ||
  !deploymentUrl.hostname.endsWith(".vercel.app") ||
  deploymentUrl.pathname !== "/" ||
  deploymentUrl.search ||
  deploymentUrl.hash
)
  throw new Error(
    "Deployment URL must be one exact provider-owned Vercel origin.",
  );
if (!isAbsolute(outputInput))
  throw new Error("Release output must be absolute.");
const outputParent = await realpath(resolve(outputInput, ".."));
const output = join(outputParent, basename(outputInput));
try {
  await lstat(output);
  throw new Error(`Release output already exists: ${output}`);
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
await mkdir(output, { mode: 0o700 });

const git = (...args: string[]) =>
  execFileSync("/usr/bin/git", ["-C", repositoryRoot, ...args], {
    encoding: "utf8",
    env: {
      PATH: "/usr/bin:/bin",
      LC_ALL: "C",
      HOME: process.env.HOME,
      NODE_ENV: "production",
    },
  }).trim();
if (git("status", "--porcelain=v1", "--untracked-files=all") !== "")
  throw new Error("Release promotion requires a clean exact checkout.");
const source = {
  repository: "https://github.com/withAutograph/autograph-app-builder",
  sha: git("rev-parse", "HEAD"),
  tree: git("rev-parse", "HEAD^{tree}"),
};
gitObject.parse(source.sha);
gitObject.parse(source.tree);

const node = process.env.APP_BUILDER_RELEASE_NODE_BIN;
if (!node || !isAbsolute(node))
  throw new Error("mise must supply APP_BUILDER_RELEASE_NODE_BIN.");
const packageRoot = join(output, "package");
execFileSync(
  node,
  [
    "--import",
    "tsx",
    "scripts/build-portable-release.mts",
    "--endpoint",
    new URL(endpoint).origin,
    "--output",
    packageRoot,
  ],
  { cwd: repositoryRoot, env: process.env, stdio: "inherit" },
);
const installRoot = join(output, ".portable-install");
await mkdir(installRoot, { mode: 0o700 });
for (const client of ["codex", "vscode", "cursor"]) {
  execFileSync(
    node,
    [
      "--import",
      "tsx",
      "scripts/install-portable-plugin.mts",
      "--client",
      client,
      "--source",
      packageRoot,
      "--destination",
      installRoot,
    ],
    { cwd: repositoryRoot, env: process.env, stdio: "inherit" },
  );
}
const portable = await verifyPortableProofArtifact({
  releaseRoot: packageRoot,
  installRoot,
  repositoryRoot,
});
if (JSON.stringify(portable.receipt.tools) !== JSON.stringify(TOOL_NAMES))
  throw new Error("Release did not expose exactly the five Autograph tools.");
if (
  portable.receipt.source.sha !== source.sha ||
  portable.receipt.source.tree !== source.tree ||
  portable.receipt.endpoint !== endpoint
)
  throw new Error("Portable package source or endpoint binding drifted.");

const response = await fetch(`${new URL(endpoint).origin}/healthz`, {
  redirect: "error",
  signal: AbortSignal.timeout(15_000),
});
if (!response.ok) throw new Error("Canonical release health check failed.");
const health = Buffer.from(await response.arrayBuffer());
const digest = (value: Uint8Array | string) =>
  createHash("sha256").update(value).digest("hex");
const packageReceipt = await readFile(
  join(packageRoot, "release-receipt.json"),
);
const checksums = await readFile(join(packageRoot, "SHA256SUMS"));
const archive = await readFile(
  join(packageRoot, portable.receipt.archive.name),
);
const marketplaceArchive = await readFile(
  join(packageRoot, portable.receipt.codexMarketplaceArchive.name),
);
const unsigned = {
  format: "autograph-release-promotion-v2",
  source,
  endpoint,
  tools: [...TOOL_NAMES],
  package: {
    version: portable.receipt.version,
    archive: portable.receipt.archive.name,
    archiveSha256: digest(archive),
    marketplaceArchive: portable.receipt.codexMarketplaceArchive.name,
    marketplaceArchiveSha256: digest(marketplaceArchive),
    receipt: "release-receipt.json",
    receiptSha256: digest(packageReceipt),
    checksums: "SHA256SUMS",
    checksumsSha256: digest(checksums),
  },
  deployment: {
    provider: "vercel-git",
    projectId: "prj_PpmXwhXGuNLAj7HHlkC1j6n3u1SY",
    environment: "Production",
    sourceSha: source.sha,
    deploymentUrl: deploymentUrl.origin,
    canonicalOrigin: new URL(endpoint).origin,
    healthSha256: digest(health),
  },
  bindings: {
    execution: "vercel-sandbox",
    authentication: "vercel-project-oidc",
    deployment: "vercel-git",
    marketplace: "immutable-release",
  },
};
const receipt = { ...unsigned, digest: digest(JSON.stringify(unsigned)) };
hash.parse(receipt.digest);
await writeFile(
  join(output, "promotion-receipt.json"),
  `${JSON.stringify(receipt, null, 2)}\n`,
  { mode: 0o600, flag: "wx" },
);
console.log(`Release candidate proved: ${receipt.digest}`);
