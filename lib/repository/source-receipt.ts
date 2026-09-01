import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";

import {
  inspectBuilderOwnedSupportedRepository,
  inspectSupportedRepository,
  inspectSupportedTemplateSnapshot,
  SUPPORTED_REPOSITORY_CONTRACT,
  SUPPORTED_TEMPLATE_ADAPTER,
  SUPPORTED_TEMPLATE_INPUT_PATHS,
  type SupportedTemplateSnapshot,
} from "./supported-template";

export type SourceKind = "existing-repository" | "fresh-template";

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
  contractPaths: readonly string[] = SUPPORTED_TEMPLATE_INPUT_PATHS,
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

export const LEGACY_SOURCE_RECEIPT_VERSION = 3 as const;
export const SOURCE_RECEIPT_VERSION = 4 as const;

export const ARRUSTED_TEMPLATE_REPOSITORY =
  "https://github.com/withAutograph/arrusted-development.git" as const;
export const ARRUSTED_TEMPLATE_REF = "refs/heads/main" as const;

export type ClonedTemplateProvenance = {
  repository: typeof ARRUSTED_TEMPLATE_REPOSITORY;
  ref: typeof ARRUSTED_TEMPLATE_REF;
  method: "git-clone-v1";
  readinessDigest: string;
};

type SourceReceiptEvidenceBase = {
  sourceKind: SourceKind;
  sourceSha: string;
  sourceTree: string;
  adapter: typeof SUPPORTED_TEMPLATE_ADAPTER;
  eligibilityDigest: string;
  /** Stable digest of the supported-template contract at the reviewed SHA. */
  contractDigest: string;
  /**
   * The exported Git tree carries no enabled release state. The local V0
   * adapter does not inspect repository-hosted variables, so this is not
   * evidence about an existing GitHub repository's current release setting.
   */
  releaseEnabled: false;
  digest: string;
};

type LegacySourceReceiptEvidence = SourceReceiptEvidenceBase & {
  version: typeof LEGACY_SOURCE_RECEIPT_VERSION;
};

type ClonedSourceReceiptEvidence = SourceReceiptEvidenceBase & {
  version: typeof SOURCE_RECEIPT_VERSION;
  provenance: ClonedTemplateProvenance;
};

export type SourceReceiptEvidence =
  LegacySourceReceiptEvidence | ClonedSourceReceiptEvidence;

export type SourceReceipt = SourceReceiptEvidence & {
  /** Local runtime locator only. It is deliberately excluded from `digest`. */
  sourcePath: string;
};

export type CanonicalTemplateSnapshot = Omit<
  SupportedTemplateSnapshot,
  "sourceSha"
> & {
  sourceSha: string;
  sourceTree: string;
  contract: Array<{
    path: string;
    mode: string;
    objectId: string;
    sha256: string;
  }>;
};

export function parseCanonicalTemplateSnapshot(
  value: unknown,
): CanonicalTemplateSnapshot {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "contents",
      "contract",
      "dirtyPaths",
      "sourcePath",
      "sourceSha",
      "sourceTree",
    ])
  )
    throw new Error("Canonical template clone inspection is invalid.");
  if (
    value.sourcePath !== "/workspace/repository" ||
    !isGitObjectId(value.sourceSha) ||
    !isGitObjectId(value.sourceTree) ||
    !Array.isArray(value.dirtyPaths) ||
    value.dirtyPaths.some((path) => typeof path !== "string") ||
    !isRecord(value.contents) ||
    !Array.isArray(value.contract)
  )
    throw new Error("Canonical template clone inspection is invalid.");
  const allowedContents = new Set([
    ...SUPPORTED_TEMPLATE_INPUT_PATHS,
    ".config/repository-template.json",
  ]);
  if (
    Object.entries(value.contents).some(
      ([path, content]) =>
        !allowedContents.has(path) || typeof content !== "string",
    )
  )
    throw new Error("Canonical template clone inspection is invalid.");
  const contents = value.contents as Partial<Record<string, string>>;
  const contract = value.contract.map((entry) => {
    if (
      !isRecord(entry) ||
      !hasExactKeys(entry, ["mode", "objectId", "path", "sha256"])
    )
      throw new Error("Canonical template clone inspection is invalid.");
    if (
      typeof entry.path !== "string" ||
      typeof entry.mode !== "string" ||
      typeof entry.objectId !== "string" ||
      typeof entry.sha256 !== "string"
    )
      throw new Error("Canonical template clone inspection is invalid.");
    return {
      path: entry.path,
      mode: entry.mode,
      objectId: entry.objectId,
      sha256: entry.sha256,
    };
  });
  for (const entry of contract) {
    const content = contents[entry.path];
    if (content !== undefined && sha256(content) !== entry.sha256)
      throw new Error("Canonical template clone inspection is invalid.");
  }
  return {
    sourcePath: value.sourcePath,
    sourceSha: value.sourceSha,
    sourceTree: value.sourceTree,
    dirtyPaths: [...value.dirtyPaths],
    contents,
    contract,
  };
}

type UnsignedSourceReceiptEvidence =
  | Omit<LegacySourceReceiptEvidence, "digest">
  | Omit<ClonedSourceReceiptEvidence, "digest">;

const legacySourceReceiptEvidenceKeys = [
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

const clonedSourceReceiptEvidenceKeys = [
  ...legacySourceReceiptEvidenceKeys,
  "provenance",
] as const;

const legacySourceReceiptKeys = [
  ...legacySourceReceiptEvidenceKeys,
  "sourcePath",
] as const;
const clonedSourceReceiptKeys = [
  ...clonedSourceReceiptEvidenceKeys,
  "sourcePath",
] as const;

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
  const common = {
    version: receipt.version,
    sourceKind: receipt.sourceKind,
    sourceSha: receipt.sourceSha,
    sourceTree: receipt.sourceTree,
    adapter: receipt.adapter,
    eligibilityDigest: receipt.eligibilityDigest,
    contractDigest: receipt.contractDigest,
    releaseEnabled: receipt.releaseEnabled,
  };
  return sha256(
    JSON.stringify(
      receipt.version === SOURCE_RECEIPT_VERSION
        ? { ...common, provenance: receipt.provenance }
        : common,
    ),
  );
}

function validProvenance(value: unknown): value is ClonedTemplateProvenance {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["method", "readinessDigest", "ref", "repository"]) &&
    value.repository === ARRUSTED_TEMPLATE_REPOSITORY &&
    value.ref === ARRUSTED_TEMPLATE_REF &&
    value.method === "git-clone-v1" &&
    isDigest(value.readinessDigest)
  );
}

export function parseSourceReceiptEvidence(
  value: unknown,
): SourceReceiptEvidence {
  if (!isRecord(value))
    throw new Error(
      "Source receipt evidence is invalid or has an unsupported schema.",
    );
  const version = value.version;
  if (
    (version === LEGACY_SOURCE_RECEIPT_VERSION &&
      !hasExactKeys(value, legacySourceReceiptEvidenceKeys)) ||
    (version === SOURCE_RECEIPT_VERSION &&
      !hasExactKeys(value, clonedSourceReceiptEvidenceKeys)) ||
    (version !== LEGACY_SOURCE_RECEIPT_VERSION &&
      version !== SOURCE_RECEIPT_VERSION)
  )
    throw new Error(
      "Source receipt evidence is invalid or has an unsupported schema.",
    );
  if (
    (value.sourceKind !== "existing-repository" &&
      value.sourceKind !== "fresh-template") ||
    (version === SOURCE_RECEIPT_VERSION &&
      value.sourceKind !== "fresh-template") ||
    !isGitObjectId(value.sourceSha) ||
    !isGitObjectId(value.sourceTree) ||
    value.adapter !== SUPPORTED_TEMPLATE_ADAPTER ||
    !isDigest(value.eligibilityDigest) ||
    !isDigest(value.contractDigest) ||
    value.releaseEnabled !== false ||
    !isDigest(value.digest) ||
    (version === SOURCE_RECEIPT_VERSION && !validProvenance(value.provenance))
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
    ...(receipt.version === SOURCE_RECEIPT_VERSION
      ? { provenance: receipt.provenance }
      : {}),
    digest: receipt.digest,
  });
}

export function parseSourceReceipt(value: unknown): SourceReceipt {
  if (
    !isRecord(value) ||
    (value.version === LEGACY_SOURCE_RECEIPT_VERSION &&
      !hasExactKeys(value, legacySourceReceiptKeys)) ||
    (value.version === SOURCE_RECEIPT_VERSION &&
      !hasExactKeys(value, clonedSourceReceiptKeys))
  )
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
  const eligible =
    sourceKind === "existing-repository"
      ? eligibility.planningEligible
      : eligibility.eligible;
  const eligibilityDigest =
    sourceKind === "existing-repository"
      ? eligibility.compatibilityDigest
      : eligibility.digest;
  const failures =
    sourceKind === "existing-repository"
      ? eligibility.planningFailures
      : eligibility.failures;
  if (!eligible || eligibility.sourceSha === undefined)
    throw new Error(`Source is not eligible: ${failures.join("; ")}`);
  const evidence = {
    version: LEGACY_SOURCE_RECEIPT_VERSION,
    sourceKind,
    sourceSha: eligibility.sourceSha,
    sourceTree: fixedGit(
      eligibility.sourcePath,
      ["rev-parse", `${eligibility.sourceSha}^{tree}`],
      "utf8",
    ).trim(),
    adapter: SUPPORTED_TEMPLATE_ADAPTER as typeof SUPPORTED_TEMPLATE_ADAPTER,
    eligibilityDigest,
    contractDigest: inspectSourceContractDigest(
      eligibility.sourcePath,
      eligibility.sourceSha,
      sourceKind === "existing-repository"
        ? SUPPORTED_REPOSITORY_CONTRACT.requiredPaths
        : SUPPORTED_TEMPLATE_INPUT_PATHS,
    ),
    releaseEnabled: false,
  } as const;
  return parseSourceReceipt({
    ...evidence,
    digest: sourceReceiptDigest(evidence),
    sourcePath: eligibility.sourcePath,
  });
}

/** Creates the V4 receipt used only for the builder-owned canonical clone. */
export async function inspectClonedTemplateSourceReceipt(input: {
  path: string;
  readinessDigest: string;
}): Promise<SourceReceipt> {
  const eligibility = await inspectBuilderOwnedSupportedRepository(input.path);
  if (!eligibility.eligible || eligibility.sourceSha === undefined)
    throw new Error(
      `Cloned template is not eligible: ${eligibility.failures.join("; ")}`,
    );
  const evidence = {
    version: SOURCE_RECEIPT_VERSION,
    sourceKind: "fresh-template" as const,
    sourceSha: eligibility.sourceSha,
    sourceTree: fixedGit(
      eligibility.sourcePath,
      ["rev-parse", `${eligibility.sourceSha}^{tree}`],
      "utf8",
    ).trim(),
    adapter: SUPPORTED_TEMPLATE_ADAPTER as typeof SUPPORTED_TEMPLATE_ADAPTER,
    eligibilityDigest: eligibility.digest,
    contractDigest: inspectSourceContractDigest(
      eligibility.sourcePath,
      eligibility.sourceSha,
    ),
    releaseEnabled: false as const,
    provenance: {
      repository: ARRUSTED_TEMPLATE_REPOSITORY,
      ref: ARRUSTED_TEMPLATE_REF,
      method: "git-clone-v1" as const,
      readinessDigest: input.readinessDigest,
    },
  };
  return parseSourceReceipt({
    ...evidence,
    digest: sourceReceiptDigest(evidence),
    sourcePath: eligibility.sourcePath,
  });
}

function contractDigestFromSnapshot(
  contract: CanonicalTemplateSnapshot["contract"],
  expectedPaths: readonly string[] = SUPPORTED_TEMPLATE_INPUT_PATHS,
): string {
  if (contract.length !== expectedPaths.length)
    throw new Error("Canonical template contract receipt is invalid.");
  const paths = new Set<string>();
  const normalized = contract.map((entry, index) => {
    const expectedPath = expectedPaths[index];
    if (
      expectedPath === undefined ||
      entry.path !== expectedPath ||
      paths.has(entry.path) ||
      !["100644", "100755"].includes(entry.mode) ||
      !isGitObjectId(entry.objectId) ||
      !isDigest(entry.sha256)
    )
      throw new Error("Canonical template contract receipt is invalid.");
    paths.add(entry.path);
    return {
      path: entry.path,
      mode: entry.mode,
      objectId: entry.objectId,
      sha256: entry.sha256,
    };
  });
  return sha256(JSON.stringify(normalized));
}

/**
 * Construct the V4 receipt from observations gathered inside the one
 * canonical sandbox clone. The host receives no second checkout; it only
 * evaluates the closed adapter snapshot and contract entries emitted by that
 * detached clone.
 */
export function inspectCanonicalTemplateSnapshotReceipt(input: {
  snapshot: CanonicalTemplateSnapshot;
  readinessDigest: string;
}): SourceReceipt {
  const eligibility = inspectSupportedTemplateSnapshot(input.snapshot);
  if (!eligibility.eligible || eligibility.sourceSha === undefined)
    throw new Error(
      `Cloned template is not eligible: ${eligibility.failures.join("; ")}`,
    );
  const evidence = {
    version: SOURCE_RECEIPT_VERSION,
    sourceKind: "fresh-template" as const,
    sourceSha: eligibility.sourceSha,
    sourceTree: input.snapshot.sourceTree,
    adapter: SUPPORTED_TEMPLATE_ADAPTER as typeof SUPPORTED_TEMPLATE_ADAPTER,
    eligibilityDigest: eligibility.digest,
    contractDigest: contractDigestFromSnapshot(input.snapshot.contract),
    releaseEnabled: false as const,
    provenance: {
      repository: ARRUSTED_TEMPLATE_REPOSITORY,
      ref: ARRUSTED_TEMPLATE_REF,
      method: "git-clone-v1" as const,
      readinessDigest: input.readinessDigest,
    },
  };
  return parseSourceReceipt({
    ...evidence,
    digest: sourceReceiptDigest(evidence),
    sourcePath: input.snapshot.sourcePath,
  });
}

/**
 * Construct the legacy existing-repository receipt from a closed inspection
 * produced inside the session-owned GitHub clone. The diagnostic path remains
 * the fixed sandbox workspace and is excluded from the receipt digest.
 */
export function inspectExistingRepositorySnapshotReceipt(
  snapshot: CanonicalTemplateSnapshot,
): SourceReceipt {
  if (snapshot.dirtyPaths.length !== 0)
    throw new Error("Cloned repository inspection is not clean.");
  const eligibility = inspectSupportedTemplateSnapshot(snapshot);
  if (!eligibility.planningEligible || eligibility.sourceSha === undefined)
    throw new Error(
      `Cloned repository is not eligible: ${eligibility.planningFailures.join("; ")}`,
    );
  const evidence = {
    version: LEGACY_SOURCE_RECEIPT_VERSION,
    sourceKind: "existing-repository" as const,
    sourceSha: eligibility.sourceSha,
    sourceTree: snapshot.sourceTree,
    adapter: SUPPORTED_TEMPLATE_ADAPTER as typeof SUPPORTED_TEMPLATE_ADAPTER,
    eligibilityDigest: eligibility.compatibilityDigest,
    contractDigest: contractDigestFromSnapshot(
      snapshot.contract,
      SUPPORTED_REPOSITORY_CONTRACT.requiredPaths,
    ),
    releaseEnabled: false as const,
  };
  return parseSourceReceipt({
    ...evidence,
    digest: sourceReceiptDigest(evidence),
    sourcePath: snapshot.sourcePath,
  });
}
