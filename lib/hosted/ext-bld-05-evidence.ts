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
    receiptDigest: sha256Schema,
    accepted: z.literal(true),
  })
  .strict();

export const extBld05EvidenceInputSchema = z
  .object({
    version: z.literal(1),
    source: z.object({ sha: gitObjectSchema, tree: gitObjectSchema }).strict(),
    environment: hostedDeploymentEnvironmentSchema,
    lifecycle: proofReferenceSchema
      .extend({
        exactFiveTools: z.literal(true),
        twoDistinctSubjects: z.literal(true),
        twoDistinctWorkspaces: z.literal(true),
        mutualTenantDenial: z.literal(true),
        completeInputBatchesRespondedAtomically: z.literal(true),
        discardedStartResponseRecovered: z.literal(true),
        unknownSubmissionRedispatched: z.literal(false),
      })
      .strict(),
    membershipRevocation: proofReferenceSchema
      .extend({
        nextRequestDenied: z.literal(true),
        maximumResidualTokenWindowSeconds: z.literal(300),
        immediateTokenRevocationClaimed: z.literal(false),
      })
      .strict(),
    retention: proofReferenceSchema
      .extend({
        terminalOperationRowsDeleted: z.number().int().min(1),
        unreferencedSessionRowsDeleted: z.number().int().min(1),
        reservedOperationsPreserved: z.literal(true),
      })
      .strict(),
    tenantDeletion: proofReferenceSchema
      .extend({
        revocationDrainSeconds: z.number().int().min(300),
        membershipRowsDeleted: z.literal(1),
      })
      .strict(),
    disclosureScan: proofReferenceSchema
      .extend({
        publicResponsesScanned: z.number().int().min(1),
        providerLogBytesScanned: z.number().int().nonnegative(),
        findings: z.literal(0),
      })
      .strict(),
    sourceValidation: proofReferenceSchema
      .extend({
        idleTimeoutSeconds: z.literal(HOSTED_SESSION_IDLE_TIMEOUT_MS / 1_000),
        maximumLifetimeSeconds: z.literal(
          HOSTED_SESSION_MAX_LIFETIME_MS / 1_000,
        ),
        expiredSessionDeniedBeforeTransport: z.literal(true),
        expiredSessionsExcludedFromActiveCompute: z.literal(true),
        evePackageVersion: z.literal("0.43.0"),
        continuationCredential: z.literal(
          "not-applicable-canonical-session-id-only",
        ),
      })
      .strict(),
  })
  .strict();

export type ExtBld05EvidenceInput = z.infer<typeof extBld05EvidenceInputSchema>;

export const extBld05EvidenceReceiptSchema = z
  .object({
    format: z.literal("autograph-ext-bld-05-evidence-v1"),
    source: z.object({ sha: gitObjectSchema, tree: gitObjectSchema }).strict(),
    environment: hostedDeploymentEnvironmentSchema,
    evidenceDigest: sha256Schema,
    componentReceiptDigests: z
      .tuple([
        sha256Schema,
        sha256Schema,
        sha256Schema,
        sha256Schema,
        sha256Schema,
        sha256Schema,
      ])
      .readonly(),
    claims: z
      .object({
        mutualTenantDenial: z.literal(true),
        completeInputBatchesRespondedAtomically: z.literal(true),
        discardedStartResponseRecovered: z.literal(true),
        membershipRevocationDeniedNextRequest: z.literal(true),
        maximumResidualTokenWindowSeconds: z.literal(300),
        immediateTokenRevocationClaimed: z.literal(false),
        retentionApplied: z.literal(true),
        tenantDeletionAfterDrain: z.literal(true),
        sessionIdleTimeoutSeconds: z.literal(
          HOSTED_SESSION_IDLE_TIMEOUT_MS / 1_000,
        ),
        sessionMaximumLifetimeSeconds: z.literal(
          HOSTED_SESSION_MAX_LIFETIME_MS / 1_000,
        ),
        credentialsDisclosed: z.literal(false),
        continuationCredential: z.literal(
          "not-applicable-canonical-session-id-only",
        ),
        productionReadinessClaimed: z.literal(false),
      })
      .strict(),
  })
  .strict();

export type ExtBld05EvidenceReceipt = z.infer<
  typeof extBld05EvidenceReceiptSchema
>;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
}

export function buildExtBld05EvidenceReceipt(
  input: unknown,
): ExtBld05EvidenceReceipt {
  const evidence = extBld05EvidenceInputSchema.parse(input);
  return extBld05EvidenceReceiptSchema.parse({
    format: "autograph-ext-bld-05-evidence-v1",
    source: evidence.source,
    environment: evidence.environment,
    evidenceDigest: digest(evidence),
    componentReceiptDigests: [
      evidence.lifecycle.receiptDigest,
      evidence.membershipRevocation.receiptDigest,
      evidence.retention.receiptDigest,
      evidence.tenantDeletion.receiptDigest,
      evidence.disclosureScan.receiptDigest,
      evidence.sourceValidation.receiptDigest,
    ],
    claims: {
      mutualTenantDenial: true,
      completeInputBatchesRespondedAtomically: true,
      discardedStartResponseRecovered: true,
      membershipRevocationDeniedNextRequest: true,
      maximumResidualTokenWindowSeconds: 300,
      immediateTokenRevocationClaimed: false,
      retentionApplied: true,
      tenantDeletionAfterDrain: true,
      sessionIdleTimeoutSeconds: HOSTED_SESSION_IDLE_TIMEOUT_MS / 1_000,
      sessionMaximumLifetimeSeconds: HOSTED_SESSION_MAX_LIFETIME_MS / 1_000,
      credentialsDisclosed: false,
      continuationCredential: "not-applicable-canonical-session-id-only",
      productionReadinessClaimed: false,
    },
  });
}
