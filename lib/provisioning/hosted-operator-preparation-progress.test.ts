import { describe, expect, it } from "vitest";
import { operatorPreparationProgressSchema } from "./hosted-operator-contract";
import { readOperatorPreparationProgress } from "./hosted-operator-preparation-progress";
import {
  normalActorProgramDigest,
  normalActorProgramSchema,
} from "./hosted-operator-normal-actor-program";

const now = Date.parse("2026-10-28T12:00:00Z");
const program = normalActorProgramSchema.parse({
  actors: [
    {
      account: "capture-existing",
      actorKey: "reader",
      email: "reader@example.test",
      name: "Reader",
    },
  ],
  appAccess: [],
  appId: "reports",
  memberships: [],
  organizations: [],
  origin: "https://reports.example",
  version: 1,
});
type ProgressRecord = Parameters<typeof readOperatorPreparationProgress>[0];
const fixture = (): ProgressRecord & { operator: NonNullable<ProgressRecord["operator"]> } => ({
  operator: {
    plan: {
      effects: [
        { description: "Read Auth schema", id: "auth-schema", kind: "install" },
        { description: "Bind Gateway", id: "gateway-bindings", kind: "gateway-bindings" },
        { description: "Deliver Gateway", id: "gateway", kind: "gateway-delivery" },
        { description: "Observe Gateway", id: "other-gateway", kind: "gateway-delivery" },
      ],
      normalActorProgram: program,
      stage: "auth-bootstrap",
    },
    receipts: [
      {
        effectId: "auth-schema",
        observedAt: new Date(now).toISOString(),
        resourceVersion: "private-version",
      },
    ],
  },
});

describe("recorded preparation progress", () => {
  it("keeps partial bootstrap distinct from existing Auth readiness and exposes no private values", () => {
    const record = {
      ...fixture(),
      operator: {
        ...fixture().operator,
        authPreparation: { catalogFingerprint: "old-auth-readiness" },
        pendingEffectAttempt: { id: "private-attempt" },
        pendingEffectId: "gateway",
      },
      privateState: { credential: "private-credential" },
    };
    const before = structuredClone(record);
    const progress = readOperatorPreparationProgress(record, now);
    expect(operatorPreparationProgressSchema.parse(progress)).toEqual({
      accountsCompleted: false,
      allPlanEffectsReceipted: false,
      hasAccountPreparation: false,
      hasPendingAttempt: true,
      hasPendingEffect: true,
      lease: "absent",
      missingEffectKinds: ["gateway-bindings", "gateway-delivery"],
      pendingEffectKind: "gateway-delivery",
      planStage: "auth-bootstrap",
    });
    expect(record).toEqual(before);
    const output = JSON.stringify(progress);
    for (const privateValue of [
      "private-credential",
      "private-attempt",
      "private-version",
      "old-auth-readiness",
      "reader@example.test",
      program.origin,
      normalActorProgramDigest(program),
    ]) {
      expect(output).not.toContain(privateValue);
    }
  });

  it("reports complete receipts separately from pending markers", () => {
    const record = fixture();
    const { operator } = record;
    operator.receipts = operator.plan.effects.map((effect) => ({
      effectId: effect.id,
      observedAt: new Date(now).toISOString(),
      resourceVersion: "observed",
    }));
    operator.pendingEffectId = "unknown-private-effect";
    const progress = readOperatorPreparationProgress(record, now);
    expect(progress).toMatchObject({
      allPlanEffectsReceipted: true,
      hasPendingEffect: true,
      missingEffectKinds: [],
    });
    expect(progress).not.toHaveProperty("pendingEffectKind");
    expect(JSON.stringify(progress)).not.toContain("unknown-private-effect");
  });

  it.each([
    [undefined, undefined, "absent"],
    ["private-lease", "2026-10-28T12:01:00Z", "active"],
    ["private-lease", "2026-10-28T12:00:00Z", "expired"],
    ["private-lease", "2026-10-28T11:59:00Z", "expired"],
    ["private-lease", undefined, "unclassified"],
  ] as const)("classifies lease presence and expiry (%s, %s)", (leaseId, leaseExpiresAt, lease) => {
    expect(
      readOperatorPreparationProgress({ ...fixture(), leaseExpiresAt, leaseId }, now)?.lease,
    ).toBe(lease);
  });

  it.each([false, true])(
    "records account completion %s and canonical program association",
    (completed) => {
      const record = fixture();
      const accountPreparation: NonNullable<typeof record.accountPreparation> = {
        programDigest: normalActorProgramDigest(program),
      };
      if (completed) {
        accountPreparation.accountsCompletedAt = new Date(now).toISOString();
      }
      record.accountPreparation = accountPreparation;
      expect(readOperatorPreparationProgress(record, now)).toMatchObject({
        accountProgramMatchesPlan: true,
        accountsCompleted: completed,
        hasAccountPreparation: true,
      });
      record.accountPreparation.programDigest = "a".repeat(64);
      expect(readOperatorPreparationProgress(record, now)?.accountProgramMatchesPlan).toBe(false);
      delete record.operator.plan.normalActorProgram;
      expect(readOperatorPreparationProgress(record, now)).not.toHaveProperty(
        "accountProgramMatchesPlan",
      );
    },
  );

  it("supports legacy missing stages and missing operator without inventing facts", () => {
    const record = fixture();
    delete record.operator.plan.stage;
    expect(readOperatorPreparationProgress(record, now)).not.toHaveProperty("planStage");
    expect(readOperatorPreparationProgress({}, now)).toBeUndefined();
  });
});
