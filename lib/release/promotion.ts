import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

import { list as listTar } from "tar";
import { z } from "zod";

import { IMAGE_PLATFORM, IMAGE_REPOSITORY } from "../image/lifecycle";
import { portableReleaseReceiptSchema } from "../../scripts/portable-proof-artifact";
import {
  releaseEndpoint,
  sha256,
  TOOL_NAMES,
} from "../../scripts/portable-release";

const hash = z.string().regex(/^[0-9a-f]{64}$/u);
const gitObject = z.string().regex(/^[0-9a-f]{40}$/u);
const safePath = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !isAbsolute(value) &&
      !value.includes("\\") &&
      value
        .split("/")
        .every((part) => part !== "" && part !== "." && part !== ".."),
    "Candidate paths must be safe relative paths.",
  );
const exactImageReference = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*@sha256:[0-9a-f]{64}$/u);
const imageTag = z
  .string()
  .regex(
    /^ghcr[.]io\/withautograph\/autograph-app-builder-sandbox:release-[0-9a-f]{16}$/u,
  );
const localImageTag = z
  .string()
  .regex(
    /^ghcr[.]io\/withautograph\/autograph-app-builder-sandbox:candidate-[0-9a-f]{16}$/u,
  );

const proofSchema = z
  .object({
    eval: z.union([
      z.literal("sandbox-reviewed-change-set"),
      z.literal("sandbox-existing-iteration"),
    ]),
    terminalPhase: z.literal("reviewed"),
    browserPreview: z.literal(true),
    publicationAttempted: z.literal(false),
    outputSha256: hash,
  })
  .strict();

const promotionReceiptUnsignedSchema = z
  .object({
    format: z.literal("autograph-release-promotion-v1"),
    builder: z
      .object({
        repository: z.literal(
          "https://github.com/withAutograph/autograph-app-builder",
        ),
        commit: gitObject,
        tree: gitObject,
        clean: z.literal(true),
      })
      .strict(),
    arrusted: z
      .object({ commit: gitObject, tree: gitObject, clean: z.literal(true) })
      .strict(),
    platform: z
      .object({
        image: z.literal(IMAGE_PLATFORM),
        sanitizedSourceEntriesSha256: hash,
        sanitizedSourceEntryCount: z.number().int().positive(),
        dockerfileSha256: hash,
        closureSha256: hash,
      })
      .strict(),
    endpoint: z.string().url().startsWith("https://").endsWith("/mcp"),
    tools: z.tuple([
      z.literal("autograph_start"),
      z.literal("autograph_get"),
      z.literal("autograph_send"),
      z.literal("autograph_respond"),
      z.literal("autograph_cancel"),
    ]),
    package: z
      .object({
        version: z.literal("0.2.10"),
        root: safePath,
        receipt: safePath,
        receiptSha256: hash,
        archive: safePath,
        archiveSha256: hash,
        marketplaceArchive: safePath,
        marketplaceArchiveSha256: hash,
        checksums: safePath,
        checksumsSha256: hash,
      })
      .strict(),
    image: z
      .object({
        archive: safePath,
        archiveSha256: hash,
        manifestDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
        reference: exactImageReference,
        localTag: localImageTag,
        publicationTag: imageTag,
      })
      .strict(),
    deployment: z
      .object({
        root: safePath,
        outputTreeSha256: hash,
        projectBindingSha256: hash,
      })
      .strict(),
    proofs: z
      .object({
        create: proofSchema.extend({
          eval: z.literal("sandbox-reviewed-change-set"),
        }),
        iteration: proofSchema.extend({
          eval: z.literal("sandbox-existing-iteration"),
        }),
      })
      .strict(),
    bindings: z
      .object({
        execution: z.literal("release"),
        oauth: z.literal("hosted"),
        endpoint: z.literal("deployed"),
        marketplace: z.literal("release"),
        deployment: z.literal("production"),
      })
      .strict(),
  })
  .strict();

export const promotionReceiptSchema = promotionReceiptUnsignedSchema
  .extend({ digest: hash })
  .strict();

export type PromotionReceipt = z.infer<typeof promotionReceiptSchema>;
export type PromotionReceiptUnsigned = z.infer<
  typeof promotionReceiptUnsignedSchema
>;

export { sha256 };

async function sha256File(path: string) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}

export function sealPromotionReceipt(
  input: PromotionReceiptUnsigned,
): PromotionReceipt {
  const unsigned = promotionReceiptUnsignedSchema.parse(input);
  if (
    unsigned.endpoint !==
    `${releaseEndpoint(new URL(unsigned.endpoint).origin)}/mcp`
  )
    throw new Error("Release promotion requires the exact deployed /mcp URL.");
  if (
    unsigned.image.reference !==
    `${IMAGE_REPOSITORY}@${unsigned.image.manifestDigest}`
  )
    throw new Error(
      "Release image reference did not bind the candidate digest.",
    );
  if (JSON.stringify(unsigned.tools) !== JSON.stringify(TOOL_NAMES))
    throw new Error("Release promotion must expose exactly five public tools.");
  return { ...unsigned, digest: sha256(JSON.stringify(unsigned)) };
}

function git(root: string, ...args: string[]) {
  return execFileSync("/usr/bin/git", ["-C", root, ...args], {
    encoding: "utf8",
    env: {
      PATH: "/usr/bin:/bin",
      HOME: process.env.HOME,
      LC_ALL: "C",
      NODE_ENV: "production",
      GIT_TERMINAL_PROMPT: "0",
    },
  }).trim();
}

export async function exactCleanGitSource(rootInput: string, label: string) {
  if (!isAbsolute(rootInput))
    throw new Error(`${label} root must be absolute.`);
  const requested = resolve(rootInput);
  const root = await realpath(requested);
  const info = await lstat(root);
  if (
    root !== rootInput ||
    requested !== rootInput ||
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o022) !== 0
  )
    throw new Error(
      `${label} root must be canonical, current-user-owned, and not writable by another account.`,
    );
  if (git(root, "status", "--porcelain=v1", "--untracked-files=all") !== "")
    throw new Error(`${label} release source must be clean.`);
  return {
    root,
    commit: git(root, "rev-parse", "HEAD"),
    tree: git(root, "rev-parse", "HEAD^{tree}"),
  } as const;
}

async function tarEntry(path: string, requested: string) {
  let result: Buffer | undefined;
  const pending: Promise<void>[] = [];
  await listTar({
    file: path,
    strict: true,
    onReadEntry(entry) {
      if (entry.path !== requested) {
        entry.resume();
        return;
      }
      if (result !== undefined)
        throw new Error(`OCI archive repeated ${requested}.`);
      const chunks: Buffer[] = [];
      pending.push(
        new Promise<void>((resolveEntry, rejectEntry) => {
          entry.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
          entry.on("error", rejectEntry);
          entry.on("end", () => {
            result = Buffer.concat(chunks);
            resolveEntry();
          });
        }),
      );
    },
  });
  await Promise.all(pending);
  if (result === undefined)
    throw new Error(`OCI archive omitted ${requested}.`);
  return result;
}

export async function inspectOciCandidateArchive(path: string) {
  const indexBytes = await tarEntry(path, "index.json");
  const index = JSON.parse(indexBytes.toString("utf8")) as {
    schemaVersion?: unknown;
    manifests?: unknown;
  };
  if (index.schemaVersion !== 2 || !Array.isArray(index.manifests))
    throw new Error("Release OCI archive index was invalid.");
  const candidates = index.manifests.filter(
    (
      entry,
    ): entry is {
      digest: string;
      mediaType: string;
      platform: { os: string; architecture: string };
    } =>
      typeof entry === "object" &&
      entry !== null &&
      "digest" in entry &&
      typeof entry.digest === "string" &&
      /^sha256:[0-9a-f]{64}$/u.test(entry.digest) &&
      "mediaType" in entry &&
      entry.mediaType === "application/vnd.oci.image.manifest.v1+json" &&
      "platform" in entry &&
      typeof entry.platform === "object" &&
      entry.platform !== null &&
      "os" in entry.platform &&
      entry.platform.os === "linux" &&
      "architecture" in entry.platform &&
      entry.platform.architecture === "arm64",
  );
  if (candidates.length !== 1)
    throw new Error("Release OCI archive must contain one linux/arm64 image.");
  const descriptor = candidates[0]!;
  const manifestBytes = await tarEntry(
    path,
    `blobs/sha256/${descriptor.digest.slice("sha256:".length)}`,
  );
  if (`sha256:${sha256(manifestBytes)}` !== descriptor.digest)
    throw new Error("Release OCI manifest bytes did not match the index.");
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as {
    schemaVersion?: unknown;
    config?: { digest?: unknown };
    layers?: unknown;
  };
  if (
    manifest.schemaVersion !== 2 ||
    typeof manifest.config?.digest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(manifest.config.digest) ||
    !Array.isArray(manifest.layers) ||
    manifest.layers.length === 0
  )
    throw new Error("Release OCI platform manifest was incomplete.");
  return {
    manifestDigest: descriptor.digest,
    archiveSha256: await sha256File(path),
  } as const;
}

async function treeEntries(root: string, current = root): Promise<string[]> {
  const paths: string[] = [];
  for (const entry of (await readdir(current, { withFileTypes: true })).sort(
    (left, right) => left.name.localeCompare(right.name),
  )) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) paths.push(...(await treeEntries(root, path)));
    else if (entry.isFile() && !entry.isSymbolicLink())
      paths.push(relative(root, path));
    else
      throw new Error("Release deployment output contains a non-file entry.");
  }
  return paths;
}

export async function immutableTreeDigest(rootInput: string) {
  const root = await realpath(rootInput);
  const digest = createHash("sha256");
  const paths = await treeEntries(root);
  if (paths.length === 0) throw new Error("Release output tree was empty.");
  for (const path of paths) {
    const bytes = await readFile(join(root, path));
    const info = await lstat(join(root, path));
    const mode = (info.mode & 0o777).toString(8).padStart(3, "0");
    digest.update(
      `${Buffer.byteLength(path)}\0${bytes.byteLength}\0${mode}\0${path}\0`,
    );
    digest.update(bytes);
  }
  return digest.digest("hex");
}

function within(root: string, path: string) {
  const child = relative(root, path);
  return (
    child === "" ||
    (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child))
  );
}

async function exactFile(root: string, path: string, expected: string) {
  const absolute = resolve(root, path);
  if (!within(root, absolute) || basename(path) === "")
    throw new Error("Release receipt path escaped its candidate root.");
  let cursor = absolute;
  for (;;) {
    const component = await lstat(cursor);
    if (component.isSymbolicLink())
      throw new Error(`Release candidate path contained a link: ${path}`);
    if (cursor === root) break;
    const parent = resolve(cursor, "..");
    if (!within(root, parent))
      throw new Error("Release candidate path escaped its root.");
    cursor = parent;
  }
  const info = await lstat(absolute);
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error(`Release candidate file was unsafe: ${path}`);
  const bytes = await readFile(absolute);
  if (sha256(bytes) !== expected)
    throw new Error(`Release candidate bytes drifted: ${path}`);
  return bytes;
}

export async function verifyPromotionCandidate(input: {
  candidateRoot: string;
  receiptPath?: string;
}) {
  const root = await realpath(resolve(input.candidateRoot));
  const rootInfo = await lstat(root);
  if (
    root !== resolve(input.candidateRoot) ||
    !rootInfo.isDirectory() ||
    rootInfo.isSymbolicLink() ||
    rootInfo.uid !== process.getuid?.() ||
    (rootInfo.mode & 0o022) !== 0
  )
    throw new Error(
      "Release candidate root must be canonical, current-user-owned, and not writable by another account.",
    );
  const receiptPath = input.receiptPath ?? "promotion-receipt.json";
  const receiptBytes = await exactFile(
    root,
    receiptPath,
    sha256(await readFile(join(root, receiptPath))),
  );
  const receipt = promotionReceiptSchema.parse(
    JSON.parse(receiptBytes.toString("utf8")),
  );
  const { digest, ...unsigned } = receipt;
  if (sealPromotionReceipt(unsigned).digest !== digest)
    throw new Error("Release promotion receipt digest drifted.");
  const packageReceiptBytes = await exactFile(
    root,
    receipt.package.receipt,
    receipt.package.receiptSha256,
  );
  const packageReceipt = portableReleaseReceiptSchema.parse(
    JSON.parse(packageReceiptBytes.toString("utf8")),
  );
  if (
    packageReceipt.source.sha !== receipt.builder.commit ||
    packageReceipt.source.tree !== receipt.builder.tree ||
    packageReceipt.endpoint !== receipt.endpoint ||
    JSON.stringify(packageReceipt.tools) !== JSON.stringify(receipt.tools)
  )
    throw new Error("Portable package binding did not match promotion.");
  await Promise.all([
    exactFile(root, receipt.package.archive, receipt.package.archiveSha256),
    exactFile(
      root,
      receipt.package.marketplaceArchive,
      receipt.package.marketplaceArchiveSha256,
    ),
    exactFile(root, receipt.package.checksums, receipt.package.checksumsSha256),
    exactFile(root, receipt.image.archive, receipt.image.archiveSha256),
  ]);
  const observedImage = await inspectOciCandidateArchive(
    join(root, receipt.image.archive),
  );
  if (
    observedImage.manifestDigest !== receipt.image.manifestDigest ||
    observedImage.archiveSha256 !== receipt.image.archiveSha256
  )
    throw new Error("Release image archive identity drifted.");
  const deploymentRoot = join(root, receipt.deployment.root);
  if (
    (await immutableTreeDigest(join(deploymentRoot, ".vercel/output"))) !==
      receipt.deployment.outputTreeSha256 ||
    sha256(await readFile(join(deploymentRoot, ".vercel/project.json"))) !==
      receipt.deployment.projectBindingSha256
  )
    throw new Error("Release deployment bytes or binding drifted.");
  return { root, receipt, packageReceipt } as const;
}

export function releasePublicationCommands(receipt: PromotionReceipt) {
  return [
    {
      tool: "docker" as const,
      args: ["load", "--input", receipt.image.archive],
    },
    {
      tool: "docker" as const,
      args: ["tag", receipt.image.localTag, receipt.image.publicationTag],
    },
    {
      tool: "docker" as const,
      args: ["push", receipt.image.publicationTag],
    },
    {
      tool: "vercel" as const,
      args: ["deploy", "--prebuilt", "--prod", "--yes"],
      cwd: receipt.deployment.root,
    },
    {
      tool: "gh" as const,
      args: [
        "release",
        "create",
        "--repo",
        "withAutograph/autograph-app-builder",
        `v${receipt.package.version}`,
        receipt.package.archive,
        receipt.package.marketplaceArchive,
        receipt.package.checksums,
        receipt.package.receipt,
        "promotion-receipt.json",
        "--target",
        receipt.builder.commit,
        "--title",
        `Autograph App Builder v${receipt.package.version}`,
        "--notes",
        `Immutable promotion ${receipt.digest}`,
        "--prerelease",
      ],
    },
  ] as const;
}
