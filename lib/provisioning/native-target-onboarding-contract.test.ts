import { describe, expect, it } from "vitest";
import {
  nativeTargetCandidateAllowed,
  nativeTargetOnboardingPlanDigest,
  nativeTargetOnboardingPlanSchema,
  nativeTargetOnboardingRecordSchema,
  nativeTargetOnboardingRegistryId,
  nativeTargetOnboardingTableState,
  nativeTargetRequiredProjectProtection,
} from "./native-target-onboarding-contract";

const authority = {
  audience: "https://builder.example/mcp",
  issuer: "https://builder.example/api/auth",
  ownerUserId: "owner_fixture",
  workspaceId: "workspace_fixture",
};
const plan = () =>
  nativeTargetOnboardingPlanSchema.parse({
    appDatabase: {
      database: "requests_data",
      migratorRole: "requests_migrator",
      resourceId: "requests-resource",
      runtimeRole: "requests_runtime",
    },
    appId: "requests-app",
    branch: "main",
    conflictPolicy: "stop-on-conflict",
    cost: { description: "Fresh app project and separate database", ownership: "current-owner" },
    nativeNeon: {
      approvalReference: "native-scope-approval",
      nativeStore: {
        configurationId: "store-config",
        resourceId: "store-resource",
        sourceProjectId: "native-source-project",
      },
      scope: {
        branchId: "neon-branch",
        endpointId: "neon-endpoint",
        hostname: "ep-fixture.neon.tech",
        maintenanceDatabase: "maintenance",
        maintenanceRole: "installer",
        projectId: "neon-project",
      },
    },
    origin: {
      adapterGeneration: 1,
      adapterSessionId: "native_original",
      appSpecDigest: "a".repeat(64),
      publicSessionId: "public_original",
      release: {
        artifactRef: "artifact-original",
        id: "release-original",
        manifestSha256: "b".repeat(64),
        schemaSha256: "c".repeat(64),
      },
    },
    productRoles: [],
    project: {
      installationId: "install_fixture",
      name: "requests-app",
      projectSettings: {
        framework: "nextjs",
        rootDirectory: "apps/requests",
        sourceFilesOutsideRootDirectory: true,
      },
      protection: nativeTargetRequiredProjectProtection,
      teamId: "team_fixture",
    },
    retention: { policy: "Retain until explicitly approved cleanup" },
    version: 1,
    worker: {
      executablePath: "/trusted/generic-worker",
      id: "generic-installer",
      operationScope: "generated-app-release-install-v1",
      sha256: "d".repeat(64),
      subcommand: "protected-generated-app-install",
    },
  });
const record = () => {
  const p = plan();
  return {
    appId: p.appId,
    kind: "native-target-onboarding",
    plan: p,
    planDigest: nativeTargetOnboardingPlanDigest(p),
    previousAttempts: [],
    stage: "planned",
    version: 1,
  };
};

describe("native target onboarding data contract", () => {
  it("preserves empty declared roles and rejects credential/providerID fields in the plan", () => {
    expect(plan().productRoles).toEqual([]);
    expect(
      nativeTargetOnboardingPlanSchema.safeParse({ ...plan(), password: "never-store" }).success,
    ).toBe(false);
    expect(
      nativeTargetOnboardingPlanSchema.safeParse({
        ...plan(),
        project: { ...plan().project, projectId: "not-yet-created" },
      }).success,
    ).toBe(false);
    expect(
      nativeTargetOnboardingPlanSchema.safeParse({
        ...plan(),
        productRoles: ["reviewer", "reviewer"],
      }).success,
    ).toBe(false);
  });
  it("preserves accepted product role names independently of PostgreSQL identifier length", () => {
    const longProductRole = `reviewer_${"a".repeat(80)}`;
    expect(
      nativeTargetOnboardingPlanSchema.parse({ ...plan(), productRoles: [longProductRole] })
        .productRoles,
    ).toEqual([longProductRole]);
    expect(
      nativeTargetOnboardingPlanSchema.safeParse({
        ...plan(),
        appDatabase: { ...plan().appDatabase, runtimeRole: longProductRole },
      }).success,
    ).toBe(false);
  });
  it("binds semantic plan fields while ignoring JSON insertion order", () => {
    const p = plan();
    const reordered = Object.fromEntries(Object.entries(p).toReversed());
    expect(
      nativeTargetOnboardingPlanDigest(nativeTargetOnboardingPlanSchema.parse(reordered)),
    ).toBe(nativeTargetOnboardingPlanDigest(p));
    expect(nativeTargetOnboardingPlanDigest({ ...p, productRoles: ["reviewer"] })).not.toBe(
      nativeTargetOnboardingPlanDigest(p),
    );
  });
  it("uses a stable owner/app slot and separates every tenant authority coordinate", () => {
    const key = nativeTargetOnboardingRegistryId(authority, "requests-app");
    expect(key).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-a[a-f0-9]{3}-[a-f0-9]{12}$/u);
    for (const field of ["workspaceId", "ownerUserId"] as const) {
      expect(
        nativeTargetOnboardingRegistryId({ ...authority, [field]: "another" }, "requests-app"),
      ).not.toBe(key);
    }
    expect(nativeTargetOnboardingRegistryId(authority, "another-app")).not.toBe(key);
  });
  it("retains richer stages inside the only supported pending and settled table states", () => {
    const r = nativeTargetOnboardingRecordSchema.parse(record());
    expect(nativeTargetOnboardingTableState(r)).toBe("pending");
    const cancelled = nativeTargetOnboardingRecordSchema.parse({
      ...r,
      approval: {
        callId: "call",
        observedAt: "2026-10-21T15:00:00Z",
        outcome: "cancelled",
        planDigest: r.planDigest,
        publicSessionId: r.plan.origin.publicSessionId,
        requestId: "approval",
        responderPrincipalId: authority.ownerUserId,
      },
      stage: "cancelled",
    });
    expect(nativeTargetOnboardingTableState(cancelled)).toBe("settled");
  });
  it("requires exact plan binding for terminal approvals", () => {
    const r = record();
    expect(
      nativeTargetOnboardingRecordSchema.safeParse({
        ...r,
        approval: {
          callId: "call",
          observedAt: "2026-10-21T15:00:00Z",
          outcome: "approved",
          planDigest: r.planDigest,
          publicSessionId: "another-public-session",
          requestId: "approval",
          responderPrincipalId: authority.ownerUserId,
        },
        stage: "approved",
      }).success,
    ).toBe(false);
  });
  it("limits project candidates to the explicit approved conflict policy", () => {
    const p = plan();
    expect(nativeTargetCandidateAllowed(p, p.project.name)).toBe(true);
    expect(nativeTargetCandidateAllowed(p, "requests-app-abcdef")).toBe(false);
    expect(
      nativeTargetCandidateAllowed(
        { ...p, conflictPolicy: "suffix-on-confirmed-conflict" },
        "requests-app-abcdef",
      ),
    ).toBe(true);
    expect(
      nativeTargetCandidateAllowed(
        { ...p, conflictPolicy: "suffix-on-confirmed-conflict" },
        "old-app",
      ),
    ).toBe(false);
  });
});
