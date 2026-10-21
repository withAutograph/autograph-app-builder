import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hostedOperatorPlanSchema, operatorPlanDigest } from "./hosted-operator-contract";
import type {
  HostedOperatorPlan,
  HostedOperatorRecord,
  HostedOperatorRecordBase,
} from "./hosted-operator-contract";
import type { HostedRuntimeJournalRecord } from "./hosted-runtime-journal";
import {
  normalActorProgramDigest,
  normalActorProgramSchema,
} from "./hosted-operator-normal-actor-program";
import {
  matchRetainedMembershipInspectionProvenance,
  retainedMembershipInspectionProvenance,
} from "./hosted-operator-membership-inspection-provenance";

const originalPlan = hostedOperatorPlanSchema.parse({
  version: 1,
  action: "prepare",
  stage: "app",
  selection: {
    appId: "fixture-app",
    branch: "preview",
    environment: "preview",
    projectId: "prj_app",
    sessionId: "owner-session",
  },
  contextId: "owned-context",
  access: [{ actorId: "owner", organizationId: "org_fixture", roles: ["owner"] }],
  appDatabase: {
    database: "app",
    resourceId: "app-resource",
    migratorRole: "app_owner",
    runtimeRole: "app_runtime",
  },
  authDatabase: {
    database: "shared_auth",
    resourceId: "auth-resource",
    migratorRole: "auth_owner",
    runtimeRole: "auth_runtime",
  },
  neon: {
    projectId: "neon-fixture",
    branchId: "br_fixture",
    endpoint: "ep-fixture.neon.tech",
    connectionRef: "owned-connection",
    source: "synthetic-only",
  },
  authMembership: {
    kind: "create-owned-organization",
    actorId: "owner",
    organizationId: "org_fixture",
    name: "Fixture",
    slug: "fixture",
    bootstrapPlanDigest: "a".repeat(64),
    identityNonceSha256: "b".repeat(64),
    identityProof: { reference: "owned-proof", sha256: "c".repeat(64) },
    identityCapture: { capturedAt: "2028-01-01T00:00:00.000Z", realmSessionId: "realm-session" },
    identityVerification: {
      audience: "https://operator.example.test",
      issuer: "https://apps.example.test",
      jwksUrl: "https://gateway.example.test/_platform/jwks.json",
      transportSource: {
        audience: "https://operator.example.test",
        issuer: "https://oidc.vercel.com",
        ownerId: "team_fixture",
        projectId: "prj_operator",
        environment: "preview",
      },
    },
  },
  cost: { class: "shared-recovery-group", description: "Synthetic fixture", owner: "Fixture" },
  effects: [
    { id: "resources", kind: "resources", description: "Observe resources" },
    { id: "install", kind: "install", description: "Install app" },
    { id: "membership", kind: "auth-membership", description: "Create owned organization" },
    { id: "access", kind: "access", description: "Grant access" },
    { id: "bindings", kind: "bindings", description: "Bind app" },
  ],
  installer: { reference: "fixture-installer", sha256: "d".repeat(64) },
  release: { id: "fixture-release", artifactRef: "fixture-artifact", sha256: "e".repeat(64) },
  retention: { expiresAt: "2030-01-01T00:00:00.000Z", policy: "Retain owned fixture" },
  publicGateway: {
    branch: "preview",
    projectId: "prj_gateway",
    origin: "https://apps.example.test",
  },
  deploymentBoundary: {
    authority: {
      audience: "https://builder.example.test/mcp",
      issuer: "https://builder.example.test/api/auth",
      ownerUserId: "owner",
      workspaceId: "workspace",
    },
    teamId: "team_fixture",
    app: { branch: "preview", environment: "preview", projectId: "prj_app" },
    gateway: { branch: "preview", environment: "preview", projectId: "prj_gateway" },
    operator: { deploymentId: "dpl_operator", environment: "preview", projectId: "prj_operator" },
    verification: {
      publicOrigin: "https://apps.example.test",
      gatewayOrigin: "https://gateway.example.test",
      jwksUrl: "https://gateway.example.test/_platform/jwks.json",
    },
  },
});
const currentPlan = hostedOperatorPlanSchema.parse({
  ...originalPlan,
  release: { ...originalPlan.release, id: "next-release", sha256: "f".repeat(64) },
});

const canonical = (value: Record<string, string | number>): string =>
  `{${Object.entries(value)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${JSON.stringify(entry)}`)
    .join(",")}}`;

const makeOperator = (plan: HostedOperatorPlan): HostedOperatorRecordBase => {
  const spec = plan.authMembership;
  if (spec?.kind !== "create-owned-organization") {
    throw new Error("Fixture requires single owned organization");
  }
  const planDigest = operatorPlanDigest(plan);
  const marker = canonical({
    version: 1,
    purpose: "protected-owned-organization-v1",
    planDigest,
    ownerSessionId: plan.selection.sessionId,
    identityProofSha256: spec.identityProof.sha256,
    actorId: spec.actorId,
  });
  return {
    mode: "protected-operator-v1",
    approvalId: "original-approval",
    operationRef: "11111111-1111-4111-8111-111111111111",
    plan,
    planDigest,
    receipts: [
      {
        effectId:
          plan.effects.find((effect) => effect.kind === "auth-membership")?.id ?? "membership",
        observedAt: "2028-01-01T00:01:00.000Z",
        resourceVersion: createHash("sha256")
          .update(
            canonical({
              role: "owner",
              organizationId: spec.organizationId,
              marker,
              actorId: spec.actorId,
            }),
          )
          .digest("hex"),
      },
    ],
  };
};
const fixture = () => {
  const original = { approvedByCallId: "original-call", operator: makeOperator(originalPlan) };
  const operator: HostedOperatorRecord = {
    ...makeOperator(currentPlan),
    retainedProjectSettingsOperations: [original],
  };
  const record: HostedRuntimeJournalRecord = {
    version: 1,
    kind: "app-runtime",
    status: "pending",
    step: "reserved",
    approvedByCallId: "current-call",
    request: {
      ...currentPlan.selection,
      installationId: "installation",
      scopeId: "team_fixture",
      scopeType: "team",
    },
    operator,
  };
  return { record, operator, original };
};

const participantPlan = (plan: HostedOperatorPlan) => {
  const spec = plan.authMembership;
  if (spec?.kind !== "create-owned-organization") {
    throw new Error("Expected original owner specification");
  }
  const organizations = [
    spec,
    { ...spec, organizationId: "org_second", name: "Second", slug: "second" },
  ];
  const program = normalActorProgramSchema.parse({
    version: 1,
    appId: plan.selection.appId,
    origin: plan.publicGateway?.origin,
    actors: [
      {
        actorKey: "owner",
        email: "owner@example.test",
        name: "Owner",
        account: "capture-existing",
      },
    ],
    organizations: organizations.map((organization) => ({
      organizationId: organization.organizationId,
      name: organization.name,
      slug: organization.slug,
      ownerActorKey: "owner",
    })),
    memberships: organizations.map(({ organizationId }) => ({
      organizationId,
      actorKey: "owner",
      role: "owner",
    })),
    appAccess: organizations.map(({ organizationId }) => ({
      organizationId,
      actorKey: "owner",
      roles: ["owner"],
    })),
  });
  return hostedOperatorPlanSchema.parse({
    ...plan,
    normalActorProgram: program,
    normalActorPreparation: {
      accountOperationRef: "33333333-3333-4333-8333-333333333333",
      accountPlanDigest: "a".repeat(64),
      accountApprovalId: "account-approval",
      accountApprovedByCallId: "account-call",
      programDigest: normalActorProgramDigest(program),
    },
    authMembership: { kind: "create-owned-organizations", organizations },
    effects: plan.effects.flatMap((effect) =>
      effect.kind === "auth-membership"
        ? organizations.map(({ organizationId }) => ({
            ...effect,
            id: `auth-membership:${organizationId}`,
          }))
        : [effect],
    ),
  });
};

describe("retained membership inspection provenance", () => {
  it("recovers a selected organization created before its receipt, under a different operation", () => {
    const { record, operator, original } = fixture();
    const plan = participantPlan(currentPlan);
    operator.plan = plan;
    operator.planDigest = operatorPlanDigest(plan);
    operator.operationRef = "22222222-2222-4222-8222-222222222222";
    original.operator.receipts = [];
    const before = structuredClone(record);
    const candidates = retainedMembershipInspectionProvenance(record, plan, "org_fixture");
    expect(candidates.map((candidate) => candidate.operator.planDigest)).toEqual([
      original.operator.planDigest,
    ]);
    expect(candidates[0]?.effect.id).toBe("membership");
    expect(
      matchRetainedMembershipInspectionProvenance(record, plan, {
        approvedByCallId: original.approvedByCallId,
        planDigest: original.operator.planDigest,
      })?.operator,
    ).toBe(original.operator);
    expect(retainedMembershipInspectionProvenance(record, plan, "org_second")).toEqual([]);
    expect(record).toEqual(before);
  });

  it("selects the original organization effect from a plural participant plan", () => {
    const { record, operator, original } = fixture();
    const prior = participantPlan(originalPlan);
    const plan = participantPlan(currentPlan);
    original.operator = {
      ...original.operator,
      plan: prior,
      planDigest: operatorPlanDigest(prior),
      receipts: [],
    };
    operator.plan = plan;
    operator.planDigest = operatorPlanDigest(plan);
    const candidate = retainedMembershipInspectionProvenance(record, plan, "org_second")[0];
    expect(candidate?.effect.id).toBe("auth-membership:org_second");
    expect(candidate?.operator.plan).toBe(prior);
  });

  it("keeps the original approved capture when the current owner proof changes", () => {
    const { record, operator, original } = fixture();
    const plan = participantPlan(currentPlan);
    if (plan.authMembership?.kind !== "create-owned-organizations") {
      throw new Error("Expected participant organizations");
    }
    const current = plan.authMembership.organizations[0];
    if (current === undefined) {
      throw new Error("Expected owner organization");
    }
    current.identityProof = { reference: "fresh-owner-proof", sha256: "8".repeat(64) };
    current.identityCapture = {
      capturedAt: "2028-01-02T00:00:00.000Z",
      realmSessionId: "fresh-realm-session",
    };
    operator.plan = hostedOperatorPlanSchema.parse(plan);
    operator.planDigest = operatorPlanDigest(operator.plan);
    original.operator.receipts = [];
    const candidate = retainedMembershipInspectionProvenance(
      record,
      operator.plan,
      "org_fixture",
    )[0];
    expect(candidate?.operator.plan.authMembership).toEqual(originalPlan.authMembership);
  });

  it.each([
    "organization",
    "actor",
    "owner",
    "Auth resource",
    "Neon branch",
    "verification",
  ] as const)(
    "rejects selected organization history outside the current %s authority",
    (mismatch) => {
      const { record, operator, original } = fixture();
      const plan = participantPlan(currentPlan);
      operator.plan = plan;
      operator.planDigest = operatorPlanDigest(plan);
      const prior = structuredClone(originalPlan);
      if (
        prior.authMembership?.kind !== "create-owned-organization" ||
        prior.deploymentBoundary === undefined
      ) {
        throw new Error("Expected original owner authority");
      }
      if (mismatch === "organization") {
        prior.authMembership.organizationId = "other-org";
      }
      if (mismatch === "actor") {
        prior.authMembership.actorId = "other-actor";
      }
      if (mismatch === "owner") {
        prior.deploymentBoundary.authority.ownerUserId = "other-owner";
      }
      if (mismatch === "Auth resource") {
        prior.authDatabase.resourceId = "other-auth";
      }
      if (mismatch === "Neon branch") {
        prior.neon.branchId = "br_other";
      }
      if (mismatch === "verification") {
        prior.authMembership.identityVerification.transportSource.projectId = "prj_other";
      }
      original.operator = {
        ...original.operator,
        plan: hostedOperatorPlanSchema.parse(prior),
        planDigest: operatorPlanDigest(prior),
        receipts: [],
      };
      expect(retainedMembershipInspectionProvenance(record, plan, "org_fixture")).toEqual([]);
    },
  );

  it("returns no evidence without history and never changes the journal", () => {
    const { record, operator } = fixture();
    delete operator.retainedProjectSettingsOperations;
    const before = structuredClone(record);
    expect(retainedMembershipInspectionProvenance(record, currentPlan)).toEqual([]);
    expect(record).toEqual(before);
    expect(
      retainedMembershipInspectionProvenance({ ...record, operator: undefined }, currentPlan),
    ).toEqual([]);
  });

  it("finds exact original ownership receipt and matches its private approval identity", () => {
    const { record, original } = fixture();
    const before = structuredClone(record);
    const candidates = retainedMembershipInspectionProvenance(record, currentPlan);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.operator).toBe(original.operator);
    expect(candidates[0]?.effect.id).toBe("membership");
    expect(
      matchRetainedMembershipInspectionProvenance(record, currentPlan, {
        approvedByCallId: original.approvedByCallId,
        planDigest: original.operator.planDigest,
      }),
    ).toEqual(candidates[0]);
    expect(
      matchRetainedMembershipInspectionProvenance(record, currentPlan, {
        approvedByCallId: "another-call",
        planDigest: original.operator.planDigest,
      }),
    ).toBeUndefined();
    expect(
      matchRetainedMembershipInspectionProvenance(record, currentPlan, {
        approvedByCallId: original.approvedByCallId,
        planDigest: operatorPlanDigest(currentPlan),
      }),
    ).toBeUndefined();
    expect(record).toEqual(before);
  });

  it("searches all finite histories and ready-delivery snapshots, deduplicating original plans", () => {
    const { record, operator, original } = fixture();
    delete operator.retainedProjectSettingsOperations;
    for (const key of [
      "retainedInstallerOperations",
      "retainedGatewayDeliveries",
      "retainedRenewalOperations",
    ] as const) {
      operator[key] = [original];
      expect(retainedMembershipInspectionProvenance(record, currentPlan)).toHaveLength(1);
      delete operator.retainedInstallerOperations;
      delete operator.retainedGatewayDeliveries;
      delete operator.retainedRenewalOperations;
    }
    operator.retainedReadyDeliveryOperations = [
      {
        approvedByCallId: "archived-call",
        operator: {
          ...makeOperator(currentPlan),
          retainedProjectSettingsOperations: [original],
          retainedRenewalOperations: [original],
        },
      },
    ];
    expect(retainedMembershipInspectionProvenance(record, currentPlan)).toHaveLength(1);
    operator.retainedReadyDeliveryOperations = [original];
    expect(retainedMembershipInspectionProvenance(record, currentPlan)).toHaveLength(1);
  });

  it("retains distinct original receipt candidates for actual marker inspection", () => {
    const { record, operator } = fixture();
    const another = hostedOperatorPlanSchema.parse({
      ...originalPlan,
      installer: { ...originalPlan.installer, sha256: "7".repeat(64) },
    });
    operator.retainedInstallerOperations = [
      { approvedByCallId: "another-original-call", operator: makeOperator(another) },
    ];
    expect(retainedMembershipInspectionProvenance(record, currentPlan)).toHaveLength(2);
  });

  it("does not inspect a membership-free or participant organization-set plan", () => {
    const { record, operator } = fixture();
    const ordinary = hostedOperatorPlanSchema.parse({
      ...currentPlan,
      authMembership: undefined,
      effects: currentPlan.effects.filter((effect) => effect.kind !== "auth-membership"),
    });
    operator.plan = ordinary;
    operator.planDigest = operatorPlanDigest(ordinary);
    expect(retainedMembershipInspectionProvenance(record, ordinary)).toEqual([]);
    const group = hostedOperatorPlanSchema.parse({
      ...currentPlan,
      authMembership: {
        kind: "create-owned-organizations",
        organizations: [originalPlan.authMembership],
      },
    });
    operator.plan = group;
    operator.planDigest = operatorPlanDigest(group);
    expect(retainedMembershipInspectionProvenance(record, group)).toEqual([]);
  });

  it("allows source, installer, app database and delivery layout changes within the same Auth ownership", () => {
    const { record, operator } = fixture();
    const changed = hostedOperatorPlanSchema.parse({
      ...currentPlan,
      appDatabase: { ...currentPlan.appDatabase, database: "revised_app" },
      installer: { reference: "revised-layout-installer", sha256: "1".repeat(64) },
      delivery: {
        projectId: "prj_app",
        branch: "preview",
        repoId: "revised-repo",
        gitSha: "2".repeat(40),
      },
      effects: [
        ...currentPlan.effects,
        { id: "delivery", kind: "delivery", description: "Deliver revised app" },
      ],
      deploymentBoundary: {
        ...currentPlan.deploymentBoundary,
        app: { ...currentPlan.deploymentBoundary?.app, deploymentId: "dpl_revised_app" },
        gateway: {
          ...currentPlan.deploymentBoundary?.gateway,
          deploymentId: "dpl_revised_gateway",
        },
      },
    });
    operator.plan = changed;
    operator.planDigest = operatorPlanDigest(changed);
    expect(retainedMembershipInspectionProvenance(record, changed)).toHaveLength(1);
  });

  const mismatches: [string, (plan: HostedOperatorPlan) => void][] = [
    [
      "frozen identity proof",
      (plan) => {
        if (plan.authMembership?.kind === "create-owned-organization") {
          plan.authMembership.identityProof.sha256 = "9".repeat(64);
        }
      },
    ],
    [
      "captured session",
      (plan) => {
        if (plan.authMembership?.kind === "create-owned-organization") {
          plan.authMembership.identityCapture.realmSessionId = "other-realm-session";
        }
      },
    ],
    [
      "captured time",
      (plan) => {
        if (plan.authMembership?.kind === "create-owned-organization") {
          plan.authMembership.identityCapture.capturedAt = "2028-01-02T00:00:00.000Z";
        }
      },
    ],
    [
      "organization",
      (plan) => {
        if (plan.authMembership?.kind === "create-owned-organization") {
          plan.authMembership.organizationId = "other-org";
        }
      },
    ],
    [
      "actor",
      (plan) => {
        if (plan.authMembership?.kind === "create-owned-organization") {
          plan.authMembership.actorId = "other-actor";
        }
      },
    ],
    [
      "Auth resource",
      (plan) => {
        plan.authDatabase.resourceId = "other-auth";
      },
    ],
    [
      "Auth database",
      (plan) => {
        plan.authDatabase.database = "other_auth";
      },
    ],
    [
      "Neon branch",
      (plan) => {
        plan.neon.branchId = "br_other";
      },
    ],
    [
      "owner session",
      (plan) => {
        plan.selection.sessionId = "other-session";
      },
    ],
    [
      "context",
      (plan) => {
        plan.contextId = "other-context";
      },
    ],
    [
      "owner",
      (plan) => {
        if (plan.deploymentBoundary) {
          plan.deploymentBoundary.authority.ownerUserId = "other-owner";
        }
      },
    ],
    [
      "workspace",
      (plan) => {
        if (plan.deploymentBoundary) {
          plan.deploymentBoundary.authority.workspaceId = "other-workspace";
        }
      },
    ],
    [
      "team",
      (plan) => {
        if (plan.deploymentBoundary) {
          plan.deploymentBoundary.teamId = "other-team";
        }
      },
    ],
    [
      "operator",
      (plan) => {
        if (plan.deploymentBoundary) {
          plan.deploymentBoundary.operator.projectId = "prj_other_operator";
        }
      },
    ],
    [
      "membership effect",
      (plan) => {
        const effect = plan.effects.find((entry) => entry.kind === "auth-membership");
        if (effect) {
          effect.id = "other-membership";
        }
      },
    ],
  ];
  it.each(mismatches)(
    "rejects changed %s authority even with a valid receipt for that other plan",
    (_name, change) => {
      const { record, original } = fixture();
      const changed = structuredClone(originalPlan);
      change(changed);
      original.operator = makeOperator(hostedOperatorPlanSchema.parse(changed));
      expect(retainedMembershipInspectionProvenance(record, currentPlan)).toEqual([]);
    },
  );

  const missingEvidence: [string, (value: ReturnType<typeof fixture>) => void][] = [
    [
      "receipt",
      ({ original }) => {
        original.operator.receipts = [];
      },
    ],
    [
      "actual ownership readback",
      ({ original }) => {
        const receipt = original.operator.receipts[0];
        if (receipt === undefined) {
          throw new Error("Expected the original ownership receipt");
        }
        receipt.resourceVersion = "unrelated-receipt";
      },
    ],
    [
      "historical canonical digest",
      ({ original }) => {
        original.operator.planDigest = "0".repeat(64);
      },
    ],
    [
      "current canonical digest",
      ({ operator }) => {
        operator.planDigest = "0".repeat(64);
      },
    ],
    [
      "full current plan",
      ({ operator }) => {
        operator.plan = originalPlan;
      },
    ],
    [
      "original approval",
      ({ original }) => {
        delete original.operator.approvalId;
      },
    ],
    [
      "original approval call",
      ({ original }) => {
        original.approvedByCallId = "";
      },
    ],
    [
      "approved original plan",
      ({ original }) => {
        original.approvedByCallId = "operator:unapproved-plan";
      },
    ],
    [
      "same operation",
      ({ original }) => {
        original.operator.operationRef = "22222222-2222-4222-8222-222222222222";
      },
    ],
    [
      "distinct historical plan",
      ({ original }) => {
        original.operator = makeOperator(currentPlan);
      },
    ],
  ];
  it.each(missingEvidence)("rejects missing %s", (_name, change) => {
    const value = fixture();
    change(value);
    expect(retainedMembershipInspectionProvenance(value.record, currentPlan)).toEqual([]);
  });

  it("excludes a copied original receipt relabeled with a later valid plan digest", () => {
    const { record, operator, original } = fixture();
    const laterPlan = hostedOperatorPlanSchema.parse({
      ...originalPlan,
      installer: { ...originalPlan.installer, sha256: "8".repeat(64) },
    });
    const copied = {
      ...original,
      operator: {
        ...original.operator,
        plan: laterPlan,
        planDigest: operatorPlanDigest(laterPlan),
      },
    };
    operator.retainedInstallerOperations = [copied];
    expect(
      retainedMembershipInspectionProvenance(record, currentPlan).map(
        (candidate) => candidate.operator.planDigest,
      ),
    ).toEqual([original.operator.planDigest]);
    delete operator.retainedProjectSettingsOperations;
    expect(retainedMembershipInspectionProvenance(record, currentPlan)).toEqual([]);
  });
});
