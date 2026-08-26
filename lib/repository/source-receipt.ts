import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";

import {
  inspectSupportedRepository,
  SUPPORTED_TEMPLATE_ADAPTER,
} from "./supported-template";

export type SourceKind = "existing-repository" | "fresh-template";

const contractPaths = [
  ".config/mise/config.toml",
  ".github/workflows/cd.yml",
  ".config/mise/scripts/repository/app-contract.ts",
  ".config/mise/scripts/repository/repository-preflight.ts",
  ".config/mise/scripts/repository/repository-release-gate.sh",
  ".config/turbo/generators/config.ts",
] as const;

const sha256 = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

function fixedGit(
  path: string,
  args: readonly string[],
  encoding: "utf8",
): string;
function fixedGit(
  path: string,
  args: readonly string[],
  encoding: "buffer",
): Buffer;
function fixedGit(
  path: string,
  args: readonly string[],
  encoding: "utf8" | "buffer",
): string | Buffer {
  const executable = existsSync("/usr/bin/git") ? "/usr/bin/git" : "/bin/git";
  return execFileSync(
    executable,
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.attributesfile=/dev/null",
      "-c",
      "credential.helper=",
      "-c",
      "protocol.allow=never",
      "-C",
      path,
      ...args,
    ],
    {
      encoding,
      env: {
        NODE_ENV: process.env.NODE_ENV ?? "production",
        PATH: "/usr/bin:/bin",
        TMPDIR: "/tmp",
        HOME: "/dev/null",
        XDG_CONFIG_HOME: "/dev/null",
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_ATTR_NOSYSTEM: "1",
        GIT_NO_LAZY_FETCH: "1",
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "/usr/bin/false",
        SSH_ASKPASS: "/usr/bin/false",
      },
      maxBuffer: 16 * 1024 * 1024,
      timeout: 30_000,
    },
  );
}

export function inspectSourceContractDigest(
  sourcePath: string,
  sourceSha: string,
): string {
  const contract = contractPaths.map((contractPath) => {
    const entry = fixedGit(
      sourcePath,
      ["ls-tree", sourceSha, "--", contractPath],
      "utf8",
    ).trim();
    const match = /^(100644|100755) blob ([0-9a-f]{40,64})\t(.+)$/u.exec(entry);
    if (match === null || match[3] !== contractPath)
      throw new Error(
        `Repository contract path is not a regular blob at ${sourceSha}: ${contractPath}`,
      );
    return {
      path: contractPath,
      mode: match[1],
      objectId: match[2],
      sha256: sha256(
        fixedGit(
          sourcePath,
          ["show", `${sourceSha}:${contractPath}`],
          "buffer",
        ),
      ),
    };
  });
  return sha256(JSON.stringify(contract));
}

export const SOURCE_RECEIPT_VERSION = 3 as const;

export type SourceReceiptEvidence = {
  version: typeof SOURCE_RECEIPT_VERSION;
  sourceKind: SourceKind;
  sourceSha: string;
  sourceTree: string;
  adapter: typeof SUPPORTED_TEMPLATE_ADAPTER;
  eligibilityDigest: string;
  /** Stable digest of the supported-template contract at the reviewed SHA. */
  contractDigest: string;
  releaseEnabled: false;
  digest: string;
};

export type SourceReceipt = SourceReceiptEvidence & {
  /** Local runtime locator only. It is deliberately excluded from `digest`. */
  sourcePath: string;
};

type UnsignedSourceReceiptEvidence = Omit<SourceReceiptEvidence, "digest">;

const sourceReceiptEvidenceKeys = [
  "adapter",
  "contractDigest",
  "digest",
  "eligibilityDigest",
  "releaseEnabled",
  "sourceKind",
  "sourceSha",
  "sourceTree",
  "version",
] as const;

const sourceReceiptKeys = [...sourceReceiptEvidenceKeys, "sourcePath"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  return (
    Object.keys(value).toSorted().join("\0") ===
    [...expected].toSorted().join("\0")
  );
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function isGitObjectId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    (/^[0-9a-f]{40}$/u.test(value) || /^[0-9a-f]{64}$/u.test(value))
  );
}

function sourceReceiptDigest(receipt: UnsignedSourceReceiptEvidence): string {
  return sha256(
    JSON.stringify({
      version: receipt.version,
      sourceKind: receipt.sourceKind,
      sourceSha: receipt.sourceSha,
      sourceTree: receipt.sourceTree,
      adapter: receipt.adapter,
      eligibilityDigest: receipt.eligibilityDigest,
      contractDigest: receipt.contractDigest,
      releaseEnabled: receipt.releaseEnabled,
    }),
  );
}

export function parseSourceReceiptEvidence(
  value: unknown,
): SourceReceiptEvidence {
  if (!isRecord(value) || !hasExactKeys(value, sourceReceiptEvidenceKeys))
    throw new Error("Source receipt evidence has an unsupported schema.");
  if (
    value.version !== SOURCE_RECEIPT_VERSION ||
    (value.sourceKind !== "existing-repository" &&
      value.sourceKind !== "fresh-template") ||
    !isGitObjectId(value.sourceSha) ||
    !isGitObjectId(value.sourceTree) ||
    value.adapter !== SUPPORTED_TEMPLATE_ADAPTER ||
    !isDigest(value.eligibilityDigest) ||
    !isDigest(value.contractDigest) ||
    value.releaseEnabled !== false ||
    !isDigest(value.digest)
  )
    throw new Error("Source receipt evidence is invalid.");
  const { digest, ...unsigned } = value as SourceReceiptEvidence;
  if (digest !== sourceReceiptDigest(unsigned))
    throw new Error("Source receipt evidence digest is invalid.");
  return value as SourceReceiptEvidence;
}

export function sourceReceiptEvidence(
  receipt: SourceReceipt,
): SourceReceiptEvidence {
  return parseSourceReceiptEvidence({
    version: receipt.version,
    sourceKind: receipt.sourceKind,
    sourceSha: receipt.sourceSha,
    sourceTree: receipt.sourceTree,
    adapter: receipt.adapter,
    eligibilityDigest: receipt.eligibilityDigest,
    contractDigest: receipt.contractDigest,
    releaseEnabled: receipt.releaseEnabled,
    digest: receipt.digest,
  });
}

export function parseSourceReceipt(value: unknown): SourceReceipt {
  if (!isRecord(value) || !hasExactKeys(value, sourceReceiptKeys))
    throw new Error("Source receipt has an unsupported schema.");
  if (typeof value.sourcePath !== "string" || !isAbsolute(value.sourcePath))
    throw new Error("Source receipt diagnostic path is invalid.");
  const { sourcePath, ...evidenceInput } = value;
  return { ...parseSourceReceiptEvidence(evidenceInput), sourcePath };
}

export async function inspectSourceReceipt(
  sourceKind: SourceKind,
  path: string,
): Promise<SourceReceipt> {
  const eligibility = await inspectSupportedRepository(path);
  if (!eligibility.eligible || eligibility.sourceSha === undefined)
    throw new Error(
      `Source is not eligible: ${eligibility.failures.join("; ")}`,
    );
  const evidence = {
    version: SOURCE_RECEIPT_VERSION,
    sourceKind,
    sourceSha: eligibility.sourceSha,
    sourceTree: fixedGit(
      eligibility.sourcePath,
      ["rev-parse", `${eligibility.sourceSha}^{tree}`],
      "utf8",
    ).trim(),
    adapter: SUPPORTED_TEMPLATE_ADAPTER,
    eligibilityDigest: eligibility.digest,
    contractDigest: inspectSourceContractDigest(
      eligibility.sourcePath,
      eligibility.sourceSha,
    ),
    releaseEnabled: false,
  } as const;
  return parseSourceReceipt({
    ...evidence,
    digest: sourceReceiptDigest(evidence),
    sourcePath: eligibility.sourcePath,
  });
}
