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
  issuer: "https://builder.example/api/auth",
  audience: "https://builder.example/mcp",
  workspaceId: "workspace_fixture",
  ownerUserId: "owner_fixture",
};
const plan = () =>
  nativeTargetOnboardingPlanSchema.parse({
    version: 1,
    appId: "requests-app",
    origin: {
      publicSessionId: "public_original",
      adapterSessionId: "native_original",
      adapterGeneration: 1,
      appSpecDigest: "a".repeat(64),
      release: {
        id: "release-original",
        artifactRef: "artifact-original",
        manifestSha256: "b".repeat(64),
        schemaSha256: "c".repeat(64),
      },
    },
    project: {
      name: "requests-app",
      teamId: "team_fixture",
      installationId: "install_fixture",
      projectSettings: {
        framework: "nextjs",
        rootDirectory: "apps/requests",
        sourceFilesOutsideRootDirectory: true,
      },
      protection: nativeTargetRequiredProjectProtection,
    },
    branch: "main",
    appDatabase: {
      resourceId: "requests-resource",
      database: "requests_data",
      migratorRole: "requests_migrator",
      runtimeRole: "requests_runtime",
    },
    productRoles: [],
    nativeNeon: {
      approvalReference: "native-scope-approval",
      nativeStore: {
        configurationId: "store-config",
        resourceId: "store-resource",
        sourceProjectId: "native-source-project",
      },
      scope: {
        projectId: "neon-project",
        branchId: "neon-branch",
        endpointId: "neon-endpoint",
        hostname: "ep-fixture.neon.tech",
        maintenanceDatabase: "maintenance",
        maintenanceRole: "installer",
      },
    },
    worker: {
      id: "generic-installer",
      executablePath: "/trusted/generic-worker",
      sha256: "d".repeat(64),
      operationScope: "generated-app-release-install-v1",
      subcommand: "protected-generated-app-install",
    },
    cost: { ownership: "current-owner", description: "Fresh app project and separate database" },
    retention: { policy: "Retain until explicitly approved cleanup" },
    conflictPolicy: "stop-on-conflict",
  });
const record = () => {
  const p = plan();
  return {
    kind: "native-target-onboarding",
    version: 1,
    appId: p.appId,
    plan: p,
    planDigest: nativeTargetOnboardingPlanDigest(p),
    stage: "planned",
    previousAttempts: [],
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
      stage: "cancelled",
      approval: {
        requestId: "approval",
        callId: "call",
        publicSessionId: r.plan.origin.publicSessionId,
        planDigest: r.planDigest,
        responderPrincipalId: authority.ownerUserId,
        observedAt: "2026-10-21T15:00:00Z",
        outcome: "cancelled",
      },
    });
    expect(nativeTargetOnboardingTableState(cancelled)).toBe("settled");
  });
  it("requires exact plan binding for terminal approvals", () => {
    const r = record();
    expect(
      nativeTargetOnboardingRecordSchema.safeParse({
        ...r,
        stage: "approved",
        approval: {
          requestId: "approval",
          callId: "call",
          publicSessionId: "another-public-session",
          planDigest: r.planDigest,
          responderPrincipalId: authority.ownerUserId,
          observedAt: "2026-10-21T15:00:00Z",
          outcome: "approved",
        },
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
