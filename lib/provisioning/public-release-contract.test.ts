import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { plan } from "./public-release-test-fixture";
import {
  publicReleasePlanSchema,
  publicReleasePlanDigest,
  publicReleaseRecordSchema,
} from "./public-release-contract";
import { initialPublicReleaseRecord } from "./public-release-store";

describe("public release additive staging metadata", () => {
  it("preserves absent original purpose and byte-stable plan digest", () => {
    const parsed = publicReleasePlanSchema.parse(plan);
    expect(parsed).not.toHaveProperty("purpose");
    expect(publicReleasePlanDigest(parsed)).toBe(
      createHash("sha256").update(JSON.stringify(parsed)).digest("hex"),
    );
  });
  it("freezes distinct public bootstrap purpose and enrollment reference", () => {
    const bootstrap = publicReleasePlanSchema.parse({
      ...plan,
      purpose: "auth-bootstrap",
      runtime: { ...plan.runtime, realmEnrollmentRef: "55555555-5555-4555-a555-555555555555" },
    });
    expect(publicReleasePlanDigest(bootstrap)).not.toBe(publicReleasePlanDigest(plan));
    expect(bootstrap.runtime.realmEnrollmentRef).toBe("55555555-5555-4555-a555-555555555555");
    expect(
      publicReleasePlanSchema.safeParse({
        ...bootstrap,
        runtime: { ...bootstrap.runtime, realmEnrollmentRef: "foreign" },
      }).success,
    ).toBe(false);
  });
  it("retains typed actual approval receipts and physical lease outside the frozen plan", () => {
    const record = publicReleaseRecordSchema.parse({
      ...initialPublicReleaseRecord(plan),
      approvalReceipts: [
        { approvalId: "genuine-native-receipt", approvedByCallId: "current-call" },
      ],
      executionLease: { fenceGeneration: 1, leaseId: "44444444-4444-4444-a444-444444444444" },
    });
    expect(record.planDigest).toBe(publicReleasePlanDigest(plan));
    expect(record.approvalReceipts?.[0].approvedByCallId).toBe("current-call");
    expect(
      publicReleaseRecordSchema.safeParse({
        ...record,
        executionLease: { ...record.executionLease, fenceGeneration: 0 },
      }).success,
    ).toBe(false);
  });
});

it("rejects a public source receipt from a different normal provisioning operation", () => {
  expect(
    publicReleasePlanSchema.safeParse({
      ...plan,
      source: {
        ...plan.source,
        deliveryScope: {
          ...plan.source.deliveryScope,
          provisioningRequestId: "99999999-9999-4999-a999-999999999999",
        },
      },
    }).success,
  ).toBe(false);
});
