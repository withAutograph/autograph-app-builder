import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";

const candidateInput =
  process.argv[process.argv.indexOf("--candidate-root") + 1];
if (!candidateInput || !isAbsolute(candidateInput))
  throw new Error("Usage: --candidate-root /absolute/proven/candidate");
const candidate = await realpath(resolve(candidateInput));
const info = await lstat(candidate);
if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o022) !== 0)
  throw new Error("Release candidate root was unsafe.");
const promotion = JSON.parse(
  await readFile(join(candidate, "promotion-receipt.json"), "utf8"),
) as {
  format: string;
  digest: string;
  source: { sha: string };
  package: {
    version: string;
    archive: string;
    archiveSha256: string;
    marketplaceArchive: string;
    marketplaceArchiveSha256: string;
    checksums: string;
    checksumsSha256: string;
    receipt: string;
    receiptSha256: string;
  };
};
if (promotion.format !== "autograph-release-promotion-v2")
  throw new Error("Unexpected promotion receipt format.");
const { digest, ...unsigned } = promotion;
const sha256 = (value: Uint8Array | string) =>
  createHash("sha256").update(value).digest("hex");
if (digest !== sha256(JSON.stringify(unsigned)))
  throw new Error("Promotion receipt digest drifted.");
const packageRoot = join(candidate, "package");
const files = [
  promotion.package.archive,
  promotion.package.marketplaceArchive,
  promotion.package.checksums,
  promotion.package.receipt,
  "promotion-receipt.json",
];
for (const file of files) {
  if (basename(file) !== file)
    throw new Error("Release asset path was unsafe.");
  const bytes = await readFile(
    file === "promotion-receipt.json"
      ? join(candidate, file)
      : join(packageRoot, file),
  );
  const expected =
    file === "promotion-receipt.json"
      ? undefined
      : file === promotion.package.archive
        ? promotion.package.archiveSha256
        : file === promotion.package.marketplaceArchive
          ? promotion.package.marketplaceArchiveSha256
          : file === promotion.package.checksums
            ? promotion.package.checksumsSha256
            : promotion.package.receiptSha256;
  if (expected && sha256(bytes) !== expected)
    throw new Error(`Release asset bytes drifted: ${file}`);
}
const tag = `v${promotion.package.version}`;
const gh = process.env.APP_BUILDER_RELEASE_GH_BIN;
if (!gh || !isAbsolute(gh))
  throw new Error("mise must supply the gh executable.");
const githubToken = process.env.APP_BUILDER_RELEASE_GITHUB_TOKEN;
if (!githubToken)
  throw new Error("The release workflow must supply its scoped GitHub token.");
execFileSync(
  gh,
  [
    "release",
    "create",
    tag,
    ...files.map((file) =>
      file === "promotion-receipt.json"
        ? join(candidate, file)
        : join(packageRoot, file),
    ),
    "--repo",
    "withAutograph/autograph-app-builder",
    "--target",
    promotion.source.sha,
    "--title",
    `Autograph App Builder ${tag}`,
    "--notes",
    `Immutable promotion ${promotion.digest}`,
    "--prerelease",
  ],
  {
    stdio: "inherit",
    env: { ...process.env, GH_TOKEN: githubToken },
  },
);
