import { describe, expect, it } from "vitest";
import { operatorPreparationProgressSchema } from "./hosted-operator-contract";
import { readOperatorPreparationProgress } from "./hosted-operator-preparation-progress";
import {
  normalActorProgramDigest,
  normalActorProgramSchema,
} from "./hosted-operator-normal-actor-program";

const now = Date.parse("2026-10-28T12:00:00Z");
const program = normalActorProgramSchema.parse({
  version: 1,
  appId: "reports",
  origin: "https://reports.example",
  actors: [
    {
      actorKey: "reader",
      email: "reader@example.test",
      name: "Reader",
      account: "capture-existing",
    },
  ],
  organizations: [],
  memberships: [],
  appAccess: [],
});
type ProgressRecord = Parameters<typeof readOperatorPreparationProgress>[0];
const fixture = (): ProgressRecord & { operator: NonNullable<ProgressRecord["operator"]> } => ({
  operator: {
    plan: {
      stage: "auth-bootstrap",
      effects: [
        { id: "auth-schema", kind: "install", description: "Read Auth schema" },
        { id: "gateway-bindings", kind: "gateway-bindings", description: "Bind Gateway" },
        { id: "gateway", kind: "gateway-delivery", description: "Deliver Gateway" },
        { id: "other-gateway", kind: "gateway-delivery", description: "Observe Gateway" },
      ],
      normalActorProgram: program,
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
      privateState: { credential: "private-credential" },
      operator: {
        ...fixture().operator,
        authPreparation: { catalogFingerprint: "old-auth-readiness" },
        pendingEffectId: "gateway",
        pendingEffectAttempt: { id: "private-attempt" },
      },
    };
    const before = structuredClone(record);
    const progress = readOperatorPreparationProgress(record, now);
    expect(operatorPreparationProgressSchema.parse(progress)).toEqual({
      planStage: "auth-bootstrap",
      lease: "absent",
      hasPendingEffect: true,
      pendingEffectKind: "gateway-delivery",
      hasPendingAttempt: true,
      allPlanEffectsReceipted: false,
      missingEffectKinds: ["gateway-bindings", "gateway-delivery"],
      hasAccountPreparation: false,
      accountsCompleted: false,
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
    const operator = record.operator;
    operator.receipts = operator.plan.effects.map((effect) => ({
      effectId: effect.id,
      observedAt: new Date(now).toISOString(),
      resourceVersion: "observed",
    }));
    operator.pendingEffectId = "unknown-private-effect";
    const progress = readOperatorPreparationProgress(record, now);
    expect(progress).toMatchObject({
      allPlanEffectsReceipted: true,
      missingEffectKinds: [],
      hasPendingEffect: true,
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
      readOperatorPreparationProgress({ ...fixture(), leaseId, leaseExpiresAt }, now)?.lease,
    ).toBe(lease);
  });

  it.each([false, true])(
    "records account completion %s and canonical program association",
    (completed) => {
      const record = fixture();
      record.accountPreparation = {
        programDigest: normalActorProgramDigest(program),
        ...(completed ? { accountsCompletedAt: new Date(now).toISOString() } : {}),
      };
      expect(readOperatorPreparationProgress(record, now)).toMatchObject({
        hasAccountPreparation: true,
        accountsCompleted: completed,
        accountProgramMatchesPlan: true,
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
