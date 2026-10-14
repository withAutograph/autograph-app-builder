/* oxlint-disable eslint/require-await -- Test dependency fixtures preserve asynchronous native interfaces without provider calls. */
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  hostedOperatorPlanSchema,
  operatorPlanDigest,
  HostedOperatorError,
} from "./hosted-operator-contract";
import {
  normalActorProgramSchema,
  normalActorProgramDigest,
} from "./hosted-operator-normal-actor-program";
import { normalActorAccountPreparationSchema } from "./hosted-operator-normal-actor-journal";
import { GENERATED_RELEASE_MEMBERS } from "./hosted-operator-sandbox-launcher";
import type {
  GeneratedAppReleaseFiles,
  HostedOperatorSandboxReadbackInput,
  HostedOperatorSandboxWorkerInput,
  createHostedOperatorSandboxLauncher,
} from "./hosted-operator-sandbox-launcher";
import type { HostedOperatorWorkerEffectContext } from "./hosted-operator-service";
import { createNormalActorOrganizationWorkers } from "./hosted-operator-normal-actor-worker";
import type { NormalActorOrganizationWorkerDependencies } from "./hosted-operator-normal-actor-worker";

const accountOperationRef = "11111111-1111-4111-8111-111111111111";
const authority = {
  issuer: "https://builder.example.test/api/auth",
  audience: "https://builder.example.test/mcp",
  ownerUserId: "owner",
  workspaceId: "workspace",
};
const target = {
  appId: "normal-app",
  branch: "preview",
  environment: "preview" as const,
  projectId: "prj_app",
  sessionId: "owner-session",
  installationId: "installation",
  scopeId: "team",
  scopeType: "team" as const,
};
const context = { authority, target };
const program = normalActorProgramSchema.parse({
  version: 1,
  appId: target.appId,
  origin: "https://apps.example.com",
  actors: [
    {
      actorKey: "owner",
      email: "owner@example.com",
      name: "Owner",
      account: "create-email-password",
    },
    { actorKey: "peer", email: "peer@example.com", name: "Peer", account: "create-email-password" },
  ],
  organizations: [
    { organizationId: "org-one", ownerActorKey: "owner", name: "One", slug: "one" },
    { organizationId: "org-two", ownerActorKey: "owner", name: "Two", slug: "two" },
  ],
  memberships: [
    { actorKey: "owner", organizationId: "org-one", role: "owner" },
    { actorKey: "peer", organizationId: "org-one", role: "member" },
    { actorKey: "owner", organizationId: "org-two", role: "owner" },
    { actorKey: "peer", organizationId: "org-two", role: "member" },
  ],
  appAccess: [
    { actorKey: "owner", organizationId: "org-one", roles: ["owner"] },
    { actorKey: "peer", organizationId: "org-two", roles: ["member"] },
  ],
});
const plan = hostedOperatorPlanSchema.parse({
  version: 1,
  stage: "auth-participants",
  action: "prepare",
  access: [],
  normalActorProgram: program,
  selection: {
    appId: target.appId,
    branch: target.branch,
    environment: target.environment,
    projectId: target.projectId,
    sessionId: target.sessionId,
  },
  appDatabase: {
    resourceId: "app-resource",
    database: "normal",
    migratorRole: "normal_owner",
    runtimeRole: "normal_runtime",
  },
  authDatabase: {
    resourceId: "auth-resource",
    database: "auth",
    migratorRole: "auth_owner",
    runtimeRole: "auth_runtime",
  },
  contextId: "accepted-spec",
  cost: { class: "shared-recovery-group", description: "Approved normal accounts", owner: "owner" },
  effects: [
    {
      id: "normal-accounts",
      kind: "normal-accounts",
      description: "Capture approved actual accounts",
    },
  ],
  installer: { reference: "owned-worker", sha256: "a".repeat(64) },
  neon: {
    branchId: "br_fixture",
    connectionRef: "owned-connection",
    endpoint: "ep-owned.neon.tech",
    projectId: "neon-owned",
    source: "synthetic-only",
  },
  release: { artifactRef: "owned-release", id: "release", sha256: "b".repeat(64) },
  retention: { expiresAt: "2030-01-01T00:00:00.000Z", policy: "Retain Auth" },
  publicGateway: { branch: target.branch, origin: program.origin, projectId: "prj_gateway" },
  deploymentBoundary: {
    authority,
    teamId: "team",
    app: {
      branch: target.branch,
      deploymentId: "dpl_app",
      environment: "preview",
      projectId: target.projectId,
    },
    gateway: {
      branch: target.branch,
      deploymentId: "dpl_gateway",
      environment: "preview",
      projectId: "prj_gateway",
    },
    operator: { deploymentId: "dpl_operator", environment: "preview", projectId: "prj_operator" },
    verification: {
      gatewayOrigin: "https://gateway.example.test",
      jwksUrl: "https://gateway.example.test/_platform/jwks.json",
      publicOrigin: program.origin,
    },
  },
});
const readbackStatuses = ["applied", "absent", "incomplete", "retryable"] as const;
type ReadbackStatus = (typeof readbackStatuses)[number];
const fixture = () => {
  const proof = "private-fixture-header.private-fixture-payload.private-fixture-signature";
  const proofSha256 = createHash("sha256").update(proof).digest("hex");
  const owner = {
    reference: "33333333-3333-4333-8333-333333333333",
    actorId: "actual-owner",
    realmSessionId: "actual-org-one-session",
    origin: program.origin,
    expiresAt: "2030-01-01T00:00:00.000Z",
  };
  const captureTime = new Date().toISOString();
  const spec = {
    kind: "create-owned-organization" as const,
    organizationId: "org-one",
    name: "One",
    slug: "one",
    actorId: owner.actorId,
    bootstrapPlanDigest: "d".repeat(64),
    identityNonceSha256: "e".repeat(64),
    identityProof: {
      reference: `_protected-operator/artifacts/realm-identity-proof/${target.appId}/${proofSha256}`,
      sha256: proofSha256,
    },
    identityCapture: { capturedAt: captureTime, realmSessionId: owner.realmSessionId },
    identityVerification: {
      issuer: program.origin,
      audience: "https://operator.example.test",
      jwksUrl: "https://gateway.example.test/_platform/jwks.json",
      transportSource: {
        issuer: "https://oidc.vercel.com",
        audience: "https://operator.example.test",
        ownerId: "team",
        projectId: "prj_operator",
        environment: "preview" as const,
      },
    },
  };
  const preparation = normalActorAccountPreparationSchema.parse({
    program,
    programDigest: normalActorProgramDigest(program),
    accountOperationRef,
    accountPlan: plan,
    accountPlanDigest: operatorPlanDigest(plan),
    accountApprovalId: "first-account-approval",
    accountApprovedByCallId: "first-account-call",
    sealedState: {
      encryptedToken: "fixture-sealed-state",
      tokenIv: "fixture-iv",
      tokenTag: "fixture-tag",
      keyVersion: "v1",
    },
    captures: [],
    organizationProofs: [
      {
        organizationId: "org-one",
        ownerActorKey: "owner",
        owner,
        transportSource: spec.identityVerification.transportSource,
        link: {
          audience: spec.identityVerification.audience,
          issuer: spec.identityVerification.issuer,
          authResourceId: plan.authDatabase.resourceId,
          bootstrapPlanDigest: spec.bootstrapPlanDigest,
          browserOrigin: program.origin,
          endpointOrigin: "https://gateway.example.test",
          ownerSessionId: target.sessionId,
          organizationId: null,
          nonceSha256: spec.identityNonceSha256,
          expiresAt: owner.expiresAt,
          consumedAt: captureTime,
          proofRef: spec.identityProof.reference,
          proofSha256,
        },
      },
    ],
  });
  const fullPlan = hostedOperatorPlanSchema.parse({
    ...plan,
    stage: "app",
    normalActorPreparation: {
      accountOperationRef,
      accountPlanDigest: preparation.accountPlanDigest,
      accountApprovalId: preparation.accountApprovalId,
      accountApprovedByCallId: preparation.accountApprovedByCallId,
      programDigest: preparation.programDigest,
    },
    authMembership: {
      kind: "create-owned-organizations",
      organizations: [
        spec,
        {
          ...spec,
          organizationId: "org-two",
          name: "Two",
          slug: "two",
          identityProof: {
            reference: `_protected-operator/artifacts/realm-identity-proof/${target.appId}/${"f".repeat(64)}`,
            sha256: "f".repeat(64),
          },
          identityCapture: { ...spec.identityCapture, realmSessionId: "actual-org-two-session" },
        },
      ],
    },
    effects: [
      { kind: "resources", id: "resources", description: "Fixture resource scope" },
      { kind: "install", id: "install", description: "Fixture release" },
      { kind: "auth-membership", id: "auth-membership:org-one", description: "One" },
      { kind: "auth-membership", id: "auth-membership:org-two", description: "Two" },
      { kind: "access", id: "access", description: "Fixture access" },
      { kind: "bindings", id: "bindings", description: "Fixture binding" },
    ],
  });
  const effect = fullPlan.effects.find((entry) => entry.id === "auth-membership:org-one");
  if (effect === undefined) {
    throw new Error("fixture_missing_effect");
  }
  let authorized = true;
  let status: ReadbackStatus = "applied";
  let unknown = false;
  const assertCurrent = vi.fn(async () => {
    if (!authorized) {
      throw new HostedOperatorError("authorization_required");
    }
  });
  const execute = vi.fn(async (_input: HostedOperatorSandboxWorkerInput) => {
    await assertCurrent();
  });
  const inspect = vi.fn(async (_input: HostedOperatorSandboxReadbackInput) => {
    await assertCurrent();
    if (unknown) {
      throw new HostedOperatorError("reconciliation_required");
    }
    return {
      version: 1 as const,
      operation_id: "22222222-2222-4222-8222-222222222222",
      context_digest: "a".repeat(64),
      fence_generation: 1,
      status,
      readback_sha256: "b".repeat(64),
    };
  });
  const createLauncher: typeof createHostedOperatorSandboxLauncher = vi.fn(() => ({
    execute,
    inspect,
  }));
  const getOidcToken = vi.fn(async () => "private-fixture-project-oidc");
  // Dispatch unit fixtures exercise this adapter; the real launcher's protocol tests cover Sandbox frames separately.
  const configuration: NormalActorOrganizationWorkerDependencies["configuration"] = {
    operator: {
      origin: "https://operator.example.test",
      projectId: "prj_operator",
      deploymentId: "dpl_operator",
      environment: "preview",
    },
    teamId: "team",
    sandbox: {
      image: "fixture-owned-worker-image",
      projectId: "prj_operator",
      teamId: "team",
      workers: {},
      authProposal: {
        executablePath: "/owned/bin/auth-proposal",
        id: "fixture-auth-proposal",
        sha256: "a".repeat(64),
      },
      authWorker: {
        id: "fixture-auth",
        executablePath: "/owned/bin/auth",
        sha256: "a".repeat(64),
        operationScope: "auth-protected-schema-v1",
        subcommand: "auth-protected-schema",
      },
      resourcesWorker: {
        id: "fixture-resources",
        executablePath: "/owned/bin/resources",
        sha256: "a".repeat(64),
        operationScope: "neon-resource-bootstrap-v1",
        subcommand: "neon-resource-bootstrap",
      },
      accessWorker: {
        id: "fixture-access",
        executablePath: "/owned/bin/access",
        sha256: "a".repeat(64),
        operationScope: "generated-app-access-v1",
        subcommand: "protected-generated-app-access",
      },
      membershipWorker: {
        id: "auth-owned-organization-v1",
        executablePath: "/owned/bin/worker",
        sha256: "a".repeat(64),
        operationScope: "auth-protected-membership-v1",
        subcommand: "auth-protected-membership",
      },
    },
  };
  const files: GeneratedAppReleaseFiles = {
    "app-artifact.json": Buffer.from("fixture-app"),
    "cue-to-sql-source-map.json": Buffer.from("fixture-map"),
    "data-operations.md": Buffer.from("fixture-doc"),
    "data-operations.ts": Buffer.from("fixture-data"),
    "data-server.ts": Buffer.from("fixture-server"),
    "operation-manifest.json": Buffer.from("fixture-ops"),
    "release-manifest.json": Buffer.from("fixture-release"),
    "runtime-coverage.json": Buffer.from("fixture-runtime"),
    "sql-bundle.sql": Buffer.from("fixture-sql"),
    "sql-manifest.json": Buffer.from("fixture-sql-manifest"),
    "transition-contract.json": Buffer.from("fixture-contract"),
    "transition-plan.json": Buffer.from("fixture-transitions"),
  };
  const retained = { preparation, spec, proof };
  const deps: NormalActorOrganizationWorkerDependencies = {
    configuration,
    assertAuthorized: assertCurrent,
    readResourceBindings: vi.fn(async () => ({
      appDatabase: { migrationUrl: "private-app-migration", runtimeUrl: "private-app-runtime" },
      authDatabase: { migrationUrl: "private-auth-migration", runtimeUrl: "private-auth-runtime" },
    })),
    readGeneratedRelease: vi.fn<NormalActorOrganizationWorkerDependencies["readGeneratedRelease"]>(
      async (_context, release) => ({
        artifactRef: release.artifactRef ?? "",
        files,
      }),
    ),
    readOrganizationProof: vi.fn(async () => retained),
  };
  const worker = createNormalActorOrganizationWorkers(deps, { createLauncher, getOidcToken });
  const effectInput: HostedOperatorWorkerEffectContext = {
    ...context,
    effect,
    plan: fullPlan,
    operationRef: "22222222-2222-4222-8222-222222222222",
    fenceGeneration: 1,
    workerAttemptId: "44444444-4444-4444-8444-444444444444",
    workerCheckpoints: [],
    assertCurrent,
    checkpoint: async () => {
      throw new Error("unused_resource_checkpoint");
    },
    bindWorkerContext: async () => {
      throw new Error("unused_binding_in_dispatch_fixture");
    },
  };
  const input = {
    effect: effectInput,
    organizationId: "org-one",
    owner,
    ownerProof: {
      actorId: owner.actorId,
      realmSessionId: owner.realmSessionId,
      reference: spec.identityProof.reference,
      sha256: spec.identityProof.sha256,
    },
  };
  return {
    worker,
    input,
    execute,
    inspect,
    createLauncher,
    getOidcToken,
    configuration,
    retained,
    deps,
    files,
    selectStatus(value: typeof status) {
      status = value;
    },
    unknown() {
      unknown = true;
    },
    revoke() {
      authorized = false;
    },
  };
};
describe("actual selected organization worker adapter", () => {
  it("passes full unchanged approval, actual selected proof, private bindings and release to the real launcher port", async () => {
    const f = fixture();
    const frozen = structuredClone(f.input.effect.plan);
    await f.worker.executeOrganization(f.input);
    expect(f.createLauncher).toHaveBeenCalledWith(f.configuration.sandbox);
    expect(f.getOidcToken).toHaveBeenCalledWith({ project: "prj_operator", team: "team" });
    const launched = f.execute.mock.calls[0]?.[0];
    expect(launched?.plan).toBe(f.input.effect.plan);
    expect(launched?.plan).toEqual(frozen);
    expect(launched?.operationRef).toBe(f.input.effect.operationRef);
    expect(launched?.database).toBe("authDatabase");
    expect(launched?.directDatabaseUrl).toBe("private-auth-migration");
    expect(launched?.accessConnections).toEqual({
      appMigrator: "private-app-migration",
      appRuntime: "private-app-runtime",
      authMigrator: "private-auth-migration",
      authRuntime: "private-auth-runtime",
    });
    expect(launched?.membershipProof).toEqual({
      proof: f.retained.proof,
      oidcToken: "private-fixture-project-oidc",
      organizationId: "org-one",
    });
    expect(launched?.generatedRelease?.files).toBe(f.files);
    expect(
      GENERATED_RELEASE_MEMBERS.every(
        (member) => launched?.generatedRelease?.files[member] === f.files[member],
      ),
    ).toBe(true);
  });
  it.each(readbackStatuses)("maps actual %s readback without inventing absence", async (status) => {
    const f = fixture();
    f.selectStatus(status);
    expect(await f.worker.inspectOrganization(f.input)).toBe(
      status === "applied" || status === "absent" ? status : "unknown",
    );
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.inspect.mock.calls[0]?.[0].readbackOnly).toBe(true);
    expect(f.inspect.mock.calls[0]?.[0].membershipProof?.organizationId).toBe("org-one");
  });
  it("keeps unknown protocol outcomes unknown", async () => {
    const f = fixture();
    f.unknown();
    expect(await f.worker.inspectOrganization(f.input)).toBe("unknown");
    expect(f.execute).not.toHaveBeenCalled();
  });
  it("rejects substituted proof/session/target and changed first approval before launching", async () => {
    await Promise.all(
      (["proof", "session", "target", "approval"] as const).map(async (change) => {
        const f = fixture();
        if (change === "proof") {
          f.retained.proof = "different-private-proof";
        }
        if (change === "session") {
          f.input.owner.realmSessionId = "different-session";
        }
        if (change === "target") {
          f.input.effect.effect = { ...f.input.effect.effect, id: "auth-membership:org-two" };
        }
        if (change === "approval") {
          f.retained.preparation.accountApprovalId = "different-first-approval";
        }
        await expect(f.worker.executeOrganization(f.input)).rejects.toMatchObject({
          code: "resource_mismatch",
        });
        expect(f.execute).not.toHaveBeenCalled();
        expect(f.inspect).not.toHaveBeenCalled();
      }),
    );
  });
  it("rechecks actual current authorization and sanitizes private reader failures", async () => {
    const f = fixture();
    f.revoke();
    await expect(f.worker.executeOrganization(f.input)).rejects.toMatchObject({
      code: "authorization_required",
    });
    expect(f.execute).not.toHaveBeenCalled();
    const broken = fixture();
    vi.mocked(broken.deps.readResourceBindings).mockRejectedValueOnce(
      new Error("private-credential-reader-details"),
    );
    await expect(broken.worker.executeOrganization(broken.input)).rejects.toMatchObject({
      code: "operator_unavailable",
    });
    expect(broken.execute).not.toHaveBeenCalled();
  });
});
