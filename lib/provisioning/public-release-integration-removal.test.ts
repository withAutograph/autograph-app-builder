/* oxlint-disable eslint/require-await -- Explicit readonly native port fixtures. */
import { expect, test, vi } from "vitest";
import { removal, retained } from "./public-release-integration-removal-test-fixture";
import { integrationTestAttachment as sourceCapability } from "./app-integration-release-test-fixture";
import { plan } from "./public-release-test-fixture";
import { publicReleasePlanDigest, publicReleasePlanSchema } from "./public-release-contract";
import { readPublicReleaseIntegrationRemoval } from "./public-release-integration-removal";
import type { PublicReleaseIntegrationRemovalPorts } from "./public-release-integration-removal";

const fixture = () => {
  const ports: PublicReleaseIntegrationRemovalPorts = {
    readPreflight: vi.fn(async () => structuredClone(removal)),
    reconcile: vi.fn<PublicReleaseIntegrationRemovalPorts["reconcile"]>(async () => "unknown"),
    apply: vi.fn<() => Promise<void>>().mockResolvedValue(),
  };
  return {
    ports,
    invocation: {
      authority: plan.authority,
      callId: "current-call",
      sessionId: plan.selection.sessionId,
      signal: new AbortController().signal,
    },
    sourceCapability,
    assertCurrent: vi.fn<() => Promise<void>>().mockResolvedValue(),
  };
};
test("explicit removal plan preserves two rows without adding integration writes or readiness", () => {
  const value = publicReleasePlanSchema.parse({
    ...plan,
    effects: ["fence-app-integration-authority", ...plan.effects],
    integrationRemoval: removal,
    purpose: "application",
    retainedOptionalBindings: retained,
  });
  expect(value.environment.some((entry) => entry.key.startsWith("APP_INTEGRATIONS_"))).toBe(false);
  expect(value.integrationCapability).toBeUndefined();
  expect(publicReleasePlanDigest(value)).not.toBe(publicReleasePlanDigest(plan));
  expect(publicReleasePlanSchema.safeParse({ ...value, effects: plan.effects }).success).toBe(
    false,
  );
  expect(
    publicReleasePlanSchema.safeParse({ ...value, integrationRemoval: undefined }).success,
  ).toBe(false);
  expect(publicReleasePlanSchema.safeParse({ ...value, purpose: "auth-bootstrap" }).success).toBe(
    false,
  );
  expect(
    publicReleasePlanSchema.safeParse({ ...value, retainedOptionalBindings: undefined }).success,
  ).toBe(false);
});
test("stopped preflight is source-bound and read-only; retry carries original frozen intent", async () => {
  const f = fixture();
  const expected = { operationRef: "11111111-1111-4111-a111-111111111111", removal };
  await expect(readPublicReleaseIntegrationRemoval({ ...f, expected })).resolves.toEqual(removal);
  expect(f.ports.readPreflight).toHaveBeenCalledWith(
    expect.objectContaining({ expected, sourceCapability }),
  );
  expect(f.assertCurrent).toHaveBeenCalledTimes(2);
  expect(f.ports.apply).not.toHaveBeenCalled();
});
test("missing actual stopped observer is actionable rather than successful source removal", async () => {
  await expect(
    readPublicReleaseIntegrationRemoval({ ...fixture(), ports: undefined }),
  ).rejects.toMatchObject({ code: "public_release_integration_removal_required" });
});
test.each(["source", "scope", "generation", "configuration"])(
  "foreign stopped observation fails closed: %s",
  async (change) => {
    const f = fixture();
    const wrong = structuredClone(removal);
    if (change === "source") {
      wrong.sourceCapability.planDigest = "e".repeat(64);
    }
    if (change === "scope") {
      wrong.scopeSha256 = "e".repeat(64);
    }
    if (change === "generation") {
      wrong.authority.principalGeneration += 1;
      wrong.authority.expectedFencedGeneration += 1;
    }
    if (change === "configuration") {
      wrong.authority.configurationSha256 = "e".repeat(64);
    }
    f.ports.readPreflight = vi.fn(async () => wrong);
    await expect(readPublicReleaseIntegrationRemoval(f)).rejects.toMatchObject({
      code: "public_release_integration_removal_required",
    });
  },
);
test("ownership revocation after actual observer returns prevents freezing removal", async () => {
  const f = fixture();
  f.assertCurrent
    .mockImplementationOnce(async () => {})
    .mockRejectedValueOnce(new Error("owner_revoked"));
  await expect(readPublicReleaseIntegrationRemoval(f)).rejects.toThrow("owner_revoked");
});
