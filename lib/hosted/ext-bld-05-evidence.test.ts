import { describe, expect, it } from "vitest";

import {
  buildExtBld05EvidenceReceipt,
  extBld05EvidenceInputSchema,
  extBld05EvidenceReceiptSchema,
} from "./ext-bld-05-evidence";

const digest = (value: string) => `sha256:${value.repeat(64)}`;
const reference = (value: string) => ({
  receiptDigest: digest(value),
  accepted: true as const,
});
const input = {
  version: 1 as const,
  source: { sha: "a".repeat(40), tree: "b".repeat(40) },
  environment: "preview" as const,
  lifecycle: {
    ...reference("1"),
    exactFiveTools: true,
    twoDistinctSubjects: true,
    twoDistinctWorkspaces: true,
    mutualTenantDenial: true,
    completeInputBatchesRespondedAtomically: true,
    discardedStartResponseRecovered: true,
    unknownSubmissionRedispatched: false,
  },
  membershipRevocation: {
    ...reference("2"),
    nextRequestDenied: true,
    maximumResidualTokenWindowSeconds: 300,
    immediateTokenRevocationClaimed: false,
  },
  retention: {
    ...reference("3"),
    terminalOperationRowsDeleted: 2,
    unreferencedSessionRowsDeleted: 1,
    reservedOperationsPreserved: true,
  },
  tenantDeletion: {
    ...reference("4"),
    revocationDrainSeconds: 300,
    membershipRowsDeleted: 1,
  },
  disclosureScan: {
    ...reference("5"),
    publicResponsesScanned: 12,
    providerLogBytesScanned: 4_096,
    findings: 0,
  },
  sourceValidation: {
    ...reference("6"),
    idleTimeoutSeconds: 1_800,
    maximumLifetimeSeconds: 86_400,
    expiredSessionDeniedBeforeTransport: true,
    expiredSessionsExcludedFromAdmission: true,
    evePackageVersion: "0.43.0" as const,
    continuationCredential: "not-applicable-canonical-session-id-only" as const,
  },
};

describe("EXT-BLD-05 evidence", () => {
  it("aggregates only accepted closed evidence without identities or secrets", () => {
    const receipt = buildExtBld05EvidenceReceipt(input);
    expect(buildExtBld05EvidenceReceipt(input)).toEqual(receipt);
    expect(receipt).toMatchObject({
      format: "autograph-ext-bld-05-evidence-v1",
      source: input.source,
      claims: {
        mutualTenantDenial: true,
        completeInputBatchesRespondedAtomically: true,
        discardedStartResponseRecovered: true,
        membershipRevocationDeniedNextRequest: true,
        maximumResidualTokenWindowSeconds: 300,
        immediateTokenRevocationClaimed: false,
        continuationCredential: "not-applicable-canonical-session-id-only",
        productionReadinessClaimed: false,
      },
    });
    expect(receipt.componentReceiptDigests).toEqual(
      ["1", "2", "3", "4", "5", "6"].map(digest),
    );
    const serialized = JSON.stringify(receipt);
    expect(serialized).not.toContain("workspace");
    expect(serialized).not.toContain("subject");
    expect(serialized).not.toContain("token");
    expect(serialized).not.toContain("endpoint");
  });

  it("rejects incomplete, failed, weakened, or unknown evidence", () => {
    for (const candidate of [
      { ...input, lifecycle: { ...input.lifecycle, accepted: false } },
      {
        ...input,
        membershipRevocation: {
          ...input.membershipRevocation,
          maximumResidualTokenWindowSeconds: 301,
        },
      },
      {
        ...input,
        tenantDeletion: {
          ...input.tenantDeletion,
          revocationDrainSeconds: 299,
        },
      },
      {
        ...input,
        disclosureScan: { ...input.disclosureScan, findings: 1 },
      },
      { ...input, ambientCredential: "secret" },
    ]) {
      expect(extBld05EvidenceInputSchema.safeParse(candidate).success).toBe(
        false,
      );
    }
  });

  it("keeps evidence separate from a Production readiness claim", () => {
    const receipt = buildExtBld05EvidenceReceipt({
      ...input,
      environment: "production",
    });
    expect(receipt.environment).toBe("production");
    expect(receipt.claims.productionReadinessClaimed).toBe(false);
    expect(() =>
      extBld05EvidenceReceiptSchema.parse({
        ...receipt,
        claims: { ...receipt.claims, productionReadinessClaimed: true },
      }),
    ).toThrow();
  });
});
