import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import nodePath from "node:path";

import { SUPPORTED_TEMPLATE_ADAPTER, SUPPORTED_TEMPLATE_INPUT_PATHS } from "./supported-template";
import type { SupportedTemplateSnapshot } from "./supported-template";
import { captureProcessStdout } from "./captured-process-output";
import { z } from "zod";

export type SourceKind = "existing-repository" | "fresh-template";

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const TEMPLATE_CLONE_METHOD = "git-clone-v1" as const;
const FRESH_TEMPLATE_KIND = "fresh-template" as const;
const INVALID_RECEIPT_DIGEST = "Source receipt evidence digest is invalid.";
const RECEIPT_UNSUPPORTED_SCHEMA = "Source receipt has an unsupported schema.";

function fixedGit(path: string, args: readonly string[], encoding: "utf-8"): string;
function fixedGit(path: string, args: readonly string[], encoding: "buffer"): Buffer;
function fixedGit(
  path: string,
  args: readonly string[],
  encoding: "utf-8" | "buffer",
): string | Buffer {
  const executable = existsSync("/usr/bin/git") ? "/usr/bin/git" : "/bin/git";
  const output = captureProcessStdout(
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
      env: {
        GIT_ATTR_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_NO_LAZY_FETCH: "1",
        GIT_TERMINAL_PROMPT: "0",
        HOME: "/dev/null",
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        NODE_ENV: process.env.NODE_ENV ?? "production",
        PATH: "/usr/bin:/bin",
        SSH_ASKPASS: "/usr/bin/false",
        TMPDIR: "/tmp",
        XDG_CONFIG_HOME: "/dev/null",
      },
    },
  );
  if (encoding === "utf-8") {
    return output.toString("utf-8");
  }
  return output;
}

export const LEGACY_SOURCE_RECEIPT_VERSION = 3 as const;
export const SOURCE_RECEIPT_VERSION = 4 as const;

export const ARRUSTED_TEMPLATE_REPOSITORY =
  "https://github.com/withAutograph/arrusted-development.git" as const;
export const ARRUSTED_TEMPLATE_REF = "refs/heads/main" as const;

export interface ClonedTemplateProvenance {
  repository: typeof ARRUSTED_TEMPLATE_REPOSITORY;
  ref: typeof ARRUSTED_TEMPLATE_REF;
  method: "git-clone-v1";
  readinessDigest: string;
}

interface SourceReceiptEvidenceBase {
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
}

type LegacySourceReceiptEvidence = SourceReceiptEvidenceBase & {
  version: typeof LEGACY_SOURCE_RECEIPT_VERSION;
};

type ClonedSourceReceiptEvidence = SourceReceiptEvidenceBase & {
  version: typeof SOURCE_RECEIPT_VERSION;
  provenance: ClonedTemplateProvenance;
};

export type SourceReceiptEvidence = LegacySourceReceiptEvidence | ClonedSourceReceiptEvidence;

export type SourceReceipt = SourceReceiptEvidence & {
  /** Local runtime locator only. It is deliberately excluded from `digest`. */
  sourcePath: string;
};

export type CanonicalTemplateSnapshot = Omit<SupportedTemplateSnapshot, "sourceSha"> & {
  sourceSha: string;
  sourceTree: string;
  contract: {
    path: string;
    mode: string;
    objectId: string;
    sha256: string;
  }[];
};

interface CanonicalTemplateSnapshotReceiptInput {
  snapshot: CanonicalTemplateSnapshot;
  readinessDigest: string;
}

const INVALID_SNAPSHOT = "Canonical template clone inspection is invalid.";
const TEMPLATE_CONFIG_PATH = ".config/repository-template.json";
const canonicalTemplateContentsSchema = z.record(z.string(), z.string());
type CanonicalTemplateContents = z.infer<typeof canonicalTemplateContentsSchema>;
const canonicalTemplateSnapshotSchema = z.strictObject({
  contents: canonicalTemplateContentsSchema,
  contract: z.array(
    z.strictObject({
      mode: z.string(),
      objectId: z.string(),
      path: z.string(),
      sha256: z.string(),
    }),
  ),
  dirtyPaths: z.array(z.string()),
  sourcePath: z.literal("/workspace/repository"),
  sourceSha: z.string().regex(/^[0-9a-f]{40}$|^[0-9a-f]{64}$/u),
  sourceTree: z.string().regex(/^[0-9a-f]{40}$|^[0-9a-f]{64}$/u),
});

export const parseCanonicalTemplateSnapshot = (
  canonicalSnapshotPayload: string,
): CanonicalTemplateSnapshot => {
  const value = canonicalTemplateSnapshotSchema.parse(JSON.parse(canonicalSnapshotPayload));
  const { dirtyPaths, contents: sourceContents } = value;
  const allowedContents = new Set([...SUPPORTED_TEMPLATE_INPUT_PATHS, TEMPLATE_CONFIG_PATH]);
  const hasUnsupportedContent = Object.keys(sourceContents).some(
    (path) => !allowedContents.has(path),
  );
  if (hasUnsupportedContent) {
    throw new Error(INVALID_SNAPSHOT);
  }
  const contents: CanonicalTemplateContents = sourceContents;
  const { contract } = value;
  for (const entry of contract) {
    const content = contents[entry.path];
    if (content !== undefined && sha256(content) !== entry.sha256) {
      throw new Error(INVALID_SNAPSHOT);
    }
  }
  const snapshot: CanonicalTemplateSnapshot = {
    contents,
    contract,
    dirtyPaths,
    sourcePath: canonicalTemplateSnapshotSchema.shape.sourcePath.parse(value.sourcePath),
    sourceSha: value.sourceSha,
    sourceTree: value.sourceTree,
  };
  return snapshot;
};

const digestSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const gitObjectIdSchema = z.string().regex(/^[0-9a-f]{40}$|^[0-9a-f]{64}$/u);
const sourceKindSchema = z.enum(["existing-repository", FRESH_TEMPLATE_KIND]);
const provenanceSchema = z.strictObject({
  method: z.literal(TEMPLATE_CLONE_METHOD),
  readinessDigest: digestSchema,
  ref: z.literal(ARRUSTED_TEMPLATE_REF),
  repository: z.literal(ARRUSTED_TEMPLATE_REPOSITORY),
});
const receiptEvidenceBaseSchema = z.object({
  adapter: z.literal(SUPPORTED_TEMPLATE_ADAPTER),
  contractDigest: digestSchema,
  digest: digestSchema,
  eligibilityDigest: digestSchema,
  releaseEnabled: z.literal(false),
  sourceKind: sourceKindSchema,
  sourceSha: gitObjectIdSchema,
  sourceTree: gitObjectIdSchema,
});
const unsignedReceiptBaseSchema = receiptEvidenceBaseSchema.omit({ digest: true });
const unsignedSourceReceiptEvidenceSchema = z.discriminatedUnion("version", [
  unsignedReceiptBaseSchema.extend({ version: z.literal(LEGACY_SOURCE_RECEIPT_VERSION) }).strict(),
  unsignedReceiptBaseSchema
    .extend({
      provenance: provenanceSchema,
      version: z.literal(SOURCE_RECEIPT_VERSION),
    })
    .strict()
    .refine((receipt) => receipt.sourceKind === FRESH_TEMPLATE_KIND),
]);
type UnsignedSourceReceiptEvidence = z.infer<typeof unsignedSourceReceiptEvidenceSchema>;
const receiptEvidenceSchema = z.discriminatedUnion("version", [
  receiptEvidenceBaseSchema.extend({ version: z.literal(LEGACY_SOURCE_RECEIPT_VERSION) }).strict(),
  receiptEvidenceBaseSchema
    .extend({
      provenance: provenanceSchema,
      version: z.literal(SOURCE_RECEIPT_VERSION),
    })
    .strict()
    .refine((receipt) => receipt.sourceKind === FRESH_TEMPLATE_KIND),
]);
const sourceReceiptSchema = z.discriminatedUnion("version", [
  receiptEvidenceBaseSchema
    .extend({
      sourcePath: z.string().refine(nodePath.isAbsolute),
      version: z.literal(LEGACY_SOURCE_RECEIPT_VERSION),
    })
    .strict(),
  receiptEvidenceBaseSchema
    .extend({
      provenance: provenanceSchema,
      sourcePath: z.string().refine(nodePath.isAbsolute),
      version: z.literal(SOURCE_RECEIPT_VERSION),
    })
    .strict()
    .refine((receipt) => receipt.sourceKind === FRESH_TEMPLATE_KIND),
]);

const sourceReceiptDigest = (receipt: UnsignedSourceReceiptEvidence): string => {
  const common = {
    adapter: receipt.adapter,
    contractDigest: receipt.contractDigest,
    eligibilityDigest: receipt.eligibilityDigest,
    releaseEnabled: receipt.releaseEnabled,
    sourceKind: receipt.sourceKind,
    sourceSha: receipt.sourceSha,
    sourceTree: receipt.sourceTree,
    version: receipt.version,
  };
  if (receipt.version === SOURCE_RECEIPT_VERSION) {
    return sha256(JSON.stringify({ ...common, provenance: receipt.provenance }));
  }
  return sha256(JSON.stringify(common));
};

const RECEIPT_EVIDENCE_ERROR = "Source receipt evidence is invalid or has an unsupported schema.";
export const parseSourceReceiptEvidence = (serializedEvidence: string): SourceReceiptEvidence => {
  const parsed = receiptEvidenceSchema.safeParse(JSON.parse(serializedEvidence));
  if (!parsed.success) {
    throw new Error(RECEIPT_EVIDENCE_ERROR);
  }
  const evidence = parsed.data;
  const { digest, ...unsignedEvidence } = evidence;
  if (digest !== sourceReceiptDigest(unsignedEvidence)) {
    throw new Error(INVALID_RECEIPT_DIGEST);
  }
  return evidence;
};

export const sourceReceiptEvidence = (receipt: SourceReceipt): SourceReceiptEvidence => {
  const value = {
    adapter: receipt.adapter,
    contractDigest: receipt.contractDigest,
    digest: receipt.digest,
    eligibilityDigest: receipt.eligibilityDigest,
    releaseEnabled: receipt.releaseEnabled,
    sourceKind: receipt.sourceKind,
    sourceSha: receipt.sourceSha,
    sourceTree: receipt.sourceTree,
    version: receipt.version,
  };
  if (receipt.version === SOURCE_RECEIPT_VERSION) {
    value.provenance = receipt.provenance;
  }
  const parsed = receiptEvidenceSchema.parse(value);
  const { digest, ...unsigned } = parsed;
  if (digest !== sourceReceiptDigest(unsigned)) {
    throw new Error(INVALID_RECEIPT_DIGEST);
  }
  return parsed;
};

export const parseSourceReceipt = (serializedReceipt: string): SourceReceipt => {
  const parsed = sourceReceiptSchema.safeParse(JSON.parse(serializedReceipt));
  if (!parsed.success) {
    throw new Error(RECEIPT_UNSUPPORTED_SCHEMA);
  }
  const { sourcePath, ...evidenceInput } = parsed.data;
  const evidence = receiptEvidenceSchema.parse(evidenceInput);
  const { digest, ...unsignedEvidence } = evidence;
  if (digest !== sourceReceiptDigest(unsignedEvidence)) {
    throw new Error(INVALID_RECEIPT_DIGEST);
  }
  return { ...evidence, sourcePath };
};

export const sourceIdentityDigest = (sourceSha: string, sourceTree: string): string =>
  sha256(JSON.stringify({ sourceSha, sourceTree }));

const createSourceReceipt = (
  unsignedInput: UnsignedSourceReceiptEvidence,
  sourcePath: string,
): SourceReceipt => {
  const unsigned = unsignedSourceReceiptEvidenceSchema.parse(unsignedInput);
  return sourceReceiptSchema.parse({
    ...unsigned,
    digest: sourceReceiptDigest(unsigned),
    sourcePath,
  });
};

export const inspectSourceReceipt = async (
  sourceKind: SourceKind,
  path: string,
): Promise<SourceReceipt> => {
  const sourceSha = fixedGit(path, ["rev-parse", "HEAD"], "utf-8").trim();
  const sourceTree = fixedGit(path, ["rev-parse", `${sourceSha}^{tree}`], "utf-8").trim();
  const observedDigest = sourceIdentityDigest(sourceSha, sourceTree);
  const evidence = unsignedSourceReceiptEvidenceSchema.parse({
    adapter: SUPPORTED_TEMPLATE_ADAPTER,
    contractDigest: observedDigest,
    eligibilityDigest: observedDigest,
    releaseEnabled: false,
    sourceKind,
    sourceSha,
    sourceTree,
    version: LEGACY_SOURCE_RECEIPT_VERSION,
  });
  return createSourceReceipt(evidence, path);
};

/**
 * Construct the existing V4 receipt from canonical clone observations. The
 * readinessDigest field is preserved for stored-receipt compatibility; current
 * acquisition records source identity there, not a claim that CI passed.
 */
export const inspectCanonicalTemplateSnapshotReceipt = (
  input: CanonicalTemplateSnapshotReceiptInput,
): SourceReceipt => {
  const observedDigest = sha256(
    JSON.stringify({
      sourceSha: input.snapshot.sourceSha,
      sourceTree: input.snapshot.sourceTree,
    }),
  );
  const evidence = unsignedSourceReceiptEvidenceSchema.parse({
    adapter: SUPPORTED_TEMPLATE_ADAPTER,
    contractDigest: observedDigest,
    eligibilityDigest: observedDigest,
    provenance: {
      method: TEMPLATE_CLONE_METHOD,
      readinessDigest: input.readinessDigest,
      ref: ARRUSTED_TEMPLATE_REF,
      repository: ARRUSTED_TEMPLATE_REPOSITORY,
    },
    releaseEnabled: false,
    sourceKind: "fresh-template",
    sourceSha: input.snapshot.sourceSha,
    sourceTree: input.snapshot.sourceTree,
    version: SOURCE_RECEIPT_VERSION,
  });
  return createSourceReceipt(evidence, input.snapshot.sourcePath);
};

/**
 * Construct the legacy existing-repository receipt from a closed inspection
 * produced inside the session-owned GitHub clone. The diagnostic path remains
 * the fixed sandbox workspace and is excluded from the receipt digest.
 */
export const inspectExistingRepositorySnapshotReceipt = (
  snapshot: CanonicalTemplateSnapshot,
): SourceReceipt => {
  // Existing repositories are dynamic inputs. Record the revision Vercel
  // actually materialized for diagnostics, but let the repository's own
  // commands determine whether it can be planned or changed.
  const observedDigest = sha256(
    JSON.stringify({
      sourceSha: snapshot.sourceSha,
      sourceTree: snapshot.sourceTree,
    }),
  );
  const evidence = unsignedSourceReceiptEvidenceSchema.parse({
    adapter: SUPPORTED_TEMPLATE_ADAPTER,
    contractDigest: observedDigest,
    eligibilityDigest: observedDigest,
    releaseEnabled: false,
    sourceKind: "existing-repository",
    sourceSha: snapshot.sourceSha,
    sourceTree: snapshot.sourceTree,
    version: LEGACY_SOURCE_RECEIPT_VERSION,
  });
  return createSourceReceipt(evidence, snapshot.sourcePath);
};
