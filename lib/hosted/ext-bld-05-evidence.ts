import { createHash } from "node:crypto";

import { z } from "zod";

import {
  HOSTED_SESSION_IDLE_TIMEOUT_MS,
  HOSTED_SESSION_MAX_LIFETIME_MS,
} from "../eve/hosted-store";
import { hostedDeploymentEnvironmentSchema } from "./deployment-environment";

const sha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const gitObjectSchema = z.string().regex(/^[a-f0-9]{40}$/u);

const proofReferenceSchema = z
  .object({
    accepted: z.literal(true),
    receiptDigest: sha256Schema,
  })
  .strict();

export const extBld05EvidenceInputSchema = z
  .object({
    disclosureScan: proofReferenceSchema
      .extend({
        findings: z.literal(0),
        providerLogBytesScanned: z.number().int().nonnegative(),
        publicResponsesScanned: z.number().int().min(1),
      })
      .strict(),
    environment: hostedDeploymentEnvironmentSchema,
    lifecycle: proofReferenceSchema
      .extend({
        completeInputBatchesRespondedAtomically: z.literal(true),
        discardedStartResponseRecovered: z.literal(true),
        exactFiveTools: z.literal(true),
        mutualTenantDenial: z.literal(true),
        twoDistinctSubjects: z.literal(true),
        twoDistinctWorkspaces: z.literal(true),
        unknownSubmissionRedispatched: z.literal(false),
      })
      .strict(),
    membershipRevocation: proofReferenceSchema
      .extend({
        immediateTokenRevocationClaimed: z.literal(false),
        maximumResidualTokenWindowSeconds: z.literal(300),
        nextRequestDenied: z.literal(true),
      })
      .strict(),
    retention: proofReferenceSchema
      .extend({
        reservedOperationsPreserved: z.literal(true),
        terminalOperationRowsDeleted: z.number().int().min(1),
        unreferencedSessionRowsDeleted: z.number().int().min(1),
      })
      .strict(),
    source: z.object({ sha: gitObjectSchema, tree: gitObjectSchema }).strict(),
    sourceValidation: proofReferenceSchema
      .extend({
        continuationCredential: z.literal("not-applicable-canonical-session-id-only"),
        evePackageVersion: z.literal("0.43.0"),
        expiredSessionDeniedBeforeTransport: z.literal(true),
        expiredSessionsExcludedFromActiveCompute: z.literal(true),
        idleTimeoutSeconds: z.literal(HOSTED_SESSION_IDLE_TIMEOUT_MS / 1000),
        maximumLifetimeSeconds: z.literal(HOSTED_SESSION_MAX_LIFETIME_MS / 1000),
      })
      .strict(),
    tenantDeletion: proofReferenceSchema
      .extend({
        membershipRowsDeleted: z.literal(1),
        revocationDrainSeconds: z.number().int().min(300),
      })
      .strict(),
    version: z.literal(1),
  })
  .strict();

export type ExtBld05EvidenceInput = z.infer<typeof extBld05EvidenceInputSchema>;

export const extBld05EvidenceReceiptSchema = z
  .object({
    claims: z
      .object({
        completeInputBatchesRespondedAtomically: z.literal(true),
        continuationCredential: z.literal("not-applicable-canonical-session-id-only"),
        credentialsDisclosed: z.literal(false),
        discardedStartResponseRecovered: z.literal(true),
        immediateTokenRevocationClaimed: z.literal(false),
        maximumResidualTokenWindowSeconds: z.literal(300),
        membershipRevocationDeniedNextRequest: z.literal(true),
        mutualTenantDenial: z.literal(true),
        productionReadinessClaimed: z.literal(false),
        retentionApplied: z.literal(true),
        sessionIdleTimeoutSeconds: z.literal(HOSTED_SESSION_IDLE_TIMEOUT_MS / 1000),
        sessionMaximumLifetimeSeconds: z.literal(HOSTED_SESSION_MAX_LIFETIME_MS / 1000),
        tenantDeletionAfterDrain: z.literal(true),
      })
      .strict(),
    componentReceiptDigests: z
      .tuple([sha256Schema, sha256Schema, sha256Schema, sha256Schema, sha256Schema, sha256Schema])
      .readonly(),
    environment: hostedDeploymentEnvironmentSchema,
    evidenceDigest: sha256Schema,
    format: z.literal("autograph-ext-bld-05-evidence-v1"),
    source: z.object({ sha: gitObjectSchema, tree: gitObjectSchema }).strict(),
  })
  .strict();

export type ExtBld05EvidenceReceipt = z.infer<typeof extBld05EvidenceReceiptSchema>;

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function canonical(value: unknown): string {
  if (Array.isArray(value)) {return `[${value.map(canonical).join(",")}]`;}
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function digest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function buildExtBld05EvidenceReceipt(input: unknown): ExtBld05EvidenceReceipt {
  const evidence = extBld05EvidenceInputSchema.parse(input);
  return extBld05EvidenceReceiptSchema.parse({
    claims: {
      completeInputBatchesRespondedAtomically: true,
      continuationCredential: "not-applicable-canonical-session-id-only",
      credentialsDisclosed: false,
      discardedStartResponseRecovered: true,
      immediateTokenRevocationClaimed: false,
      maximumResidualTokenWindowSeconds: 300,
      membershipRevocationDeniedNextRequest: true,
      mutualTenantDenial: true,
      productionReadinessClaimed: false,
      retentionApplied: true,
      sessionIdleTimeoutSeconds: HOSTED_SESSION_IDLE_TIMEOUT_MS / 1000,
      sessionMaximumLifetimeSeconds: HOSTED_SESSION_MAX_LIFETIME_MS / 1000,
      tenantDeletionAfterDrain: true,
    },
    componentReceiptDigests: [
      evidence.lifecycle.receiptDigest,
      evidence.membershipRevocation.receiptDigest,
      evidence.retention.receiptDigest,
      evidence.tenantDeletion.receiptDigest,
      evidence.disclosureScan.receiptDigest,
      evidence.sourceValidation.receiptDigest,
    ],
    environment: evidence.environment,
    evidenceDigest: digest(evidence),
    format: "autograph-ext-bld-05-evidence-v1",
    source: evidence.source,
  });
}
