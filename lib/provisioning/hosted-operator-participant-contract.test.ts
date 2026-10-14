import { describe, expect, it } from "vitest";
import {
  hostedOperatorPlanSchema,
  operatorPlanDigest,
  operatorPublicResultSchema,
  operatorRequestSchema,
  selectHostedOperatorOwnedOrganizationSpec,
} from "./hosted-operator-contract";
import type { HostedOperatorOwnedOrganizationSpec } from "./hosted-operator-contract";
import {
  normalActorProgramDigest,
  normalActorProgramSchema,
} from "./hosted-operator-normal-actor-program";

const program = normalActorProgramSchema.parse({
  version: 1,
  appId: "spend-review",
  origin: "https://public.example.com",
  actors: [
    {
      actorKey: "requester",
      email: "requester@example.com",
      name: "Requester",
      account: "create-email-password",
    },
    {
      actorKey: "reviewer",
      email: "reviewer@example.com",
      name: "Reviewer",
      account: "capture-existing",
    },
  ],
  organizations: [
    { organizationId: "org-one", ownerActorKey: "requester", name: "One", slug: "one" },
    { organizationId: "org-two", ownerActorKey: "reviewer", name: "Two", slug: "two" },
  ],
  memberships: [
    { actorKey: "requester", organizationId: "org-one", role: "owner" },
    { actorKey: "reviewer", organizationId: "org-two", role: "owner" },
  ],
  appAccess: [
    { actorKey: "requester", organizationId: "org-one", roles: ["requester"] },
    { actorKey: "reviewer", organizationId: "org-two", roles: ["reviewer"] },
  ],
});
const base = hostedOperatorPlanSchema.parse({
  version: 1,
  action: "prepare",
  stage: "app",
  access: [],
  appDatabase: {
    database: "app_db",
    migratorRole: "app_migrator",
    resourceId: "app-resource",
    runtimeRole: "app_runtime",
  },
  authDatabase: {
    database: "auth_db",
    migratorRole: "auth_migrator",
    resourceId: "auth-resource",
    runtimeRole: "auth_runtime",
  },
  contextId: "context",
  cost: {
    class: "shared-recovery-group",
    description: "Existing approved Preview",
    owner: "owner",
  },
  selection: {
    appId: "spend-review",
    branch: "feature",
    environment: "preview",
    projectId: "app-project",
    sessionId: "public-session",
  },
  publicGateway: { branch: "feature", origin: program.origin, projectId: "gateway-project" },
  deploymentBoundary: {
    app: { branch: "feature", environment: "preview", projectId: "app-project" },
    gateway: { branch: "feature", environment: "preview", projectId: "gateway-project" },
    operator: {
      deploymentId: "operator-deployment",
      environment: "preview",
      projectId: "operator-project",
    },
    authority: {
      issuer: "https://builder.example.com/api/auth",
      audience: "https://builder.example.com/mcp",
      ownerUserId: "owner",
      workspaceId: "workspace",
    },
    teamId: "team",
    verification: {
      publicOrigin: program.origin,
      gatewayOrigin: "https://gateway.example.com",
      jwksUrl: "https://gateway.example.com/_platform/jwks.json",
    },
  },
  effects: [
    { id: "resources", kind: "resources", description: "Read existing resources" },
    { id: "install", kind: "install", description: "Install app" },
    { id: "access", kind: "access", description: "Apply approved roles" },
    { id: "bindings", kind: "bindings", description: "Bind app" },
  ],
  installer: { reference: "installer", sha256: "a".repeat(64) },
  neon: {
    branchId: "branch",
    connectionRef: "private-reference",
    endpoint: "ep-example.neon.tech",
    projectId: "neon-project",
    source: "synthetic-only",
  },
  release: { artifactRef: "private-release", id: "release", sha256: "b".repeat(64) },
  retention: { expiresAt: "2030-01-01T00:00:00Z", policy: "approved" },
});
const participantPlan = () =>
  hostedOperatorPlanSchema.parse({
    ...base,
    normalActorProgram: program,
    stage: "auth-participants",
    bootstrap: { endpointId: "endpoint", maintenanceDatabase: "neondb", role: "bootstrap_role" },
    resourcesInstaller: { reference: "existing-installer", sha256: "c".repeat(64) },
    effects: [
      {
        id: "normal-accounts",
        kind: "normal-accounts",
        description: "Prepare the approved normal accounts",
      },
    ],
  });
const organization = (
  organizationId: string,
  actorId: string,
  name: string,
  slug: string,
): HostedOperatorOwnedOrganizationSpec => ({
  actorId,
  organizationId,
  name,
  slug,
  kind: "create-owned-organization",
  bootstrapPlanDigest: "d".repeat(64),
  identityCapture: { capturedAt: "2026-10-14T10:00:00Z", realmSessionId: `session-${actorId}` },
  identityNonceSha256: "e".repeat(64),
  identityProof: { reference: `proof-${actorId}`, sha256: "f".repeat(64) },
  identityVerification: {
    audience: "https://operator.example.com",
    issuer: program.origin,
    jwksUrl: "https://gateway.example.com/_platform/jwks.json",
    transportSource: {
      audience: "https://vercel.com/team",
      issuer: "https://oidc.vercel.com/team",
      ownerId: "team",
      projectId: "operator-project",
      environment: "preview",
    },
  },
});
const resolvedPlan = () =>
  hostedOperatorPlanSchema.parse({
    ...base,
    normalActorProgram: program,
    normalActorPreparation: {
      accountOperationRef: "3c16d12a-c9bc-40ea-8c7a-63836c1a3f96",
      programDigest: normalActorProgramDigest(program),
      accountPlanDigest: operatorPlanDigest(participantPlan()),
      accountApprovalId: "first-public-approval",
      accountApprovedByCallId: "first-approved-call",
    },
    access: [{ actorId: "actual-requester", organizationId: "org-one", roles: ["requester"] }],
    authMembership: {
      kind: "create-owned-organizations",
      organizations: [
        organization("org-one", "actual-requester", "One", "one"),
        organization("org-two", "actual-reviewer", "Two", "two"),
      ],
    },
    effects: [
      ...base.effects.slice(0, 2),
      {
        id: "auth-membership",
        kind: "auth-membership",
        description: "Create approved organizations",
      },
      ...base.effects.slice(2),
    ],
  });

describe("participant plan and approval contract", () => {
  it("carries the accepted program through the same internal planning request", () => {
    const request = operatorRequestSchema.parse({
      action: "plan",
      operation: "prepare",
      selection: base.selection,
      normalActorProgram: program,
    });
    expect(request.action).toBe("plan");
    expect("normalActorProgram" in request && request.normalActorProgram).toEqual(program);
    expect(operatorRequestSchema.safeParse({ ...request, approved: true }).success).toBe(false);
  });
  it("prepares only normal accounts while retaining existing resource metadata", () => {
    const plan = participantPlan();
    expect(plan.bootstrap?.endpointId).toBe("endpoint");
    expect(plan.effects.map((effect) => effect.kind)).toEqual(["normal-accounts"]);
    expect(
      operatorPublicResultSchema.parse({
        appId: program.appId,
        authenticatedBehavior: "unassessed",
        status: "participants-prepared",
        plan,
      }).status,
    ).toBe("participants-prepared");
  });
  it("retains participant requirements during Auth bootstrap without opening account effects", () => {
    const bootstrap = hostedOperatorPlanSchema.parse({
      ...base,
      stage: "auth-bootstrap",
      normalActorProgram: program,
      bootstrap: { endpointId: "endpoint", maintenanceDatabase: "neondb", role: "bootstrap_role" },
      resourcesInstaller: { reference: "bootstrap-installer", sha256: "c".repeat(64) },
      authSchema: {
        artifactRef: "auth-plan",
        installer: base.installer,
        planDigest: "d".repeat(64),
        targetDigest: "e".repeat(64),
      },
      effects: [
        {
          id: "auth-resource",
          kind: "resources",
          resourceId: base.authDatabase.resourceId,
          description: "Auth resource",
        },
        {
          id: "app-resource",
          kind: "resources",
          resourceId: base.appDatabase.resourceId,
          description: "App resource",
        },
        { id: "auth-install", kind: "install", description: "Auth schema" },
      ],
    });
    expect(bootstrap.normalActorProgram).toEqual(program);
    expect(bootstrap.effects.some((effect) => effect.kind === "normal-accounts")).toBe(false);
    expect(
      hostedOperatorPlanSchema.safeParse({
        ...bootstrap,
        effects: [{ id: "accounts", kind: "normal-accounts", description: "premature accounts" }],
      }).success,
    ).toBe(false);
  });
  it("does not authorize organization, grant or Gateway effects with the first account approval", () => {
    const plan = participantPlan();
    for (const kind of ["auth-membership", "access", "gateway-bindings"] as const) {
      expect(
        hostedOperatorPlanSchema.safeParse({
          ...plan,
          effects: [...plan.effects, { id: kind, kind, description: "unapproved" }],
        }).success,
      ).toBe(false);
    }
    expect(
      hostedOperatorPlanSchema.safeParse({
        ...plan,
        access: [{ actorId: "actor", organizationId: "org-one", roles: ["requester"] }],
      }).success,
    ).toBe(false);
  });
  it("binds participant authority to the actual selected app and hosted public origin", () => {
    const plan = participantPlan();
    expect(
      hostedOperatorPlanSchema.safeParse({
        ...plan,
        normalActorProgram: { ...program, appId: "other-app" },
      }).success,
    ).toBe(false);
    expect(
      hostedOperatorPlanSchema.safeParse({
        ...plan,
        normalActorProgram: { ...program, origin: "https://other.example.com" },
      }).success,
    ).toBe(false);
  });
  it("keeps first-approval provenance and the immutable organization list in the resolved approval", () => {
    const plan = resolvedPlan();
    expect(plan.normalActorPreparation?.accountApprovalId).toBe("first-public-approval");
    const { authMembership } = plan;
    if (authMembership === undefined) {
      throw new Error("Missing approved organization list");
    }
    const before = operatorPlanDigest(plan);
    expect(
      selectHostedOperatorOwnedOrganizationSpec(authMembership, { organizationId: "org-two" })
        .actorId,
    ).toBe("actual-reviewer");
    expect(operatorPlanDigest(plan)).toBe(before);
    expect(() =>
      selectHostedOperatorOwnedOrganizationSpec(authMembership, {
        organizationId: "unapproved-org",
      }),
    ).toThrow("target_mismatch");
    expect(
      hostedOperatorPlanSchema.safeParse({ ...plan, normalActorPreparation: undefined }).success,
    ).toBe(false);
    expect(
      hostedOperatorPlanSchema.safeParse({
        ...plan,
        normalActorPreparation: { ...plan.normalActorPreparation, programDigest: "0".repeat(64) },
      }).success,
    ).toBe(false);
  });
  it("rejects expanded roles and organizations outside the originally approved program", () => {
    const plan = resolvedPlan();
    expect(
      hostedOperatorPlanSchema.safeParse({
        ...plan,
        access: [{ actorId: "actual-requester", organizationId: "org-one", roles: ["admin"] }],
      }).success,
    ).toBe(false);
    expect(
      hostedOperatorPlanSchema.safeParse({
        ...plan,
        authMembership: {
          kind: "create-owned-organizations",
          organizations: [organization("unapproved-org", "actor", "Other", "other")],
        },
      }).success,
    ).toBe(false);
  });
  it("preserves the existing single-organization plan path", () => {
    const plan = hostedOperatorPlanSchema.parse({
      ...base,
      authMembership: organization("legacy-org", "legacy-actor", "Legacy", "legacy"),
      effects: [
        ...base.effects.slice(0, 2),
        { id: "auth-membership", kind: "auth-membership", description: "Legacy organization" },
        ...base.effects.slice(2),
      ],
    });
    if (plan.authMembership === undefined) {
      throw new Error("Missing legacy organization");
    }
    expect(selectHostedOperatorOwnedOrganizationSpec(plan.authMembership).actorId).toBe(
      "legacy-actor",
    );
  });
});
