/* oxlint-disable eslint/require-await -- In-memory ports and spool doubles are intentionally async. */
import { createHash } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import { nativeTargetAuthOnlyPlanDigest } from "./native-target-auth-only-plan-schema";
import type { NativeTargetAuthOnlyPlan } from "./native-target-auth-only-plan-schema";
import { nativeTargetAuthOnlyOwnerLinkBindingSchema } from "./native-target-auth-only-owner-link";
import { createNativeTargetAuthOnlyEntryPreparation } from "./native-target-auth-only-entry-preparation";
import type { NativeTargetAuthOnlyEntryPreparationPorts as Ports } from "./native-target-auth-only-entry-preparation";
import type { NativeTargetAuthOnlyAfterGatewayReadyInput } from "./native-target-auth-only-delivery-runtime";

const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const authority = {
  issuer: "https://builder.example/api/auth",
  audience: "https://builder.example/mcp",
  workspaceId: "workspace",
  ownerUserId: "owner",
};
const target = {
  appId: "signup-pilot",
  branch: "pilot",
  environment: "preview" as const,
  scopeType: "team" as const,
  scopeId: "team",
  projectId: "app",
  installationId: "install",
  sessionId: "saved-session",
};
const operationRef = "11111111-1111-4111-a111-111111111111";
const organizationOperationRef = "22222222-2222-4222-a222-222222222222";
const signupOperationRef = "33333333-3333-4333-a333-333333333333";
const workerAttemptId = "44444444-4444-4444-a444-444444444444";
const deliveryPlanDigest = "d".repeat(64);
const resourcePlanDigest = "c".repeat(64);
const policyDigest = "f".repeat(64);
const proof = "private-test-proof";
const consumedAt = "2026-11-06T12:00:00.000Z";
const gateway = {
  origin: "https://immutable-gateway.example",
  projectId: "gateway",
  branch: "gateway-pilot",
  deploymentId: "deployment",
  repoId: "gateway-repo",
  operationRef,
  readyState: "READY" as const,
};
const bootstrapResource = {
  version: 1,
  environment: "preview",
  hostname: "ep-pilot.neon.tech",
  port: 5432,
  schema: "public",
  database: "pilot_auth",
  migratorRole: "pilot_migrator",
  runtimeRole: "pilot_runtime",
  neon: { projectId: "neon-pilot", branchId: "br-pilot" },
};
const appRole = "pilot_user";
const issuer = "https://signup-pilot.example";
const appBrowserOrigin = "https://auth-pilot.example";
const operatorOrigin = "https://operator-pilot.example";
const authResourceId = "isolated-auth";
const organizationId = "owner-organization";
const plan: NativeTargetAuthOnlyPlan = {
  version: 1,
  kind: "native-target-auth-only",
  appId: target.appId,
  branch: target.branch,
  origin: {
    authority,
    publicSessionId: target.sessionId,
    adapterSessionId: "adapter-session",
    adapterGeneration: 1,
    appSpecDigest: "a".repeat(64),
    capturedDescription: { appId: target.appId, kind: "static", sha256: "b".repeat(64) },
  },
  publishedSource: {
    branch: target.branch,
    gitSha: "a".repeat(40),
    gitTree: "b".repeat(40),
    repositoryId: "app-repo",
    changeSetDigest: "c".repeat(64),
    reviewDigest: "d".repeat(64),
  },
  project: {
    teamId: target.scopeId,
    installationId: target.installationId,
    name: "signup-pilot",
    projectSettings: { rootDirectory: "apps/pilot" },
    protection: {
      ssoProtection: { deploymentType: "all" },
      oidcTokenConfig: { enabled: true, issuerMode: "team" },
    },
  },
  authResource: {
    profileId: "pilot-profile",
    authorityDigest: "a".repeat(64),
    resourceId: authResourceId,
    database: bootstrapResource.database,
    hostname: bootstrapResource.hostname,
    endpointId: "ep-pilot",
  },
  authSchema: {
    artifactRef: "auth-schema",
    planDigest: "a".repeat(64),
    targetDigest: "b".repeat(64),
    installer: { reference: "auth-schema", sha256: "c".repeat(64) },
  },
  appRole,
  signupPolicy: { eligibility: "approved-email-list", requireVerifiedEmail: true },
  cost: { ownership: "current-owner", description: "pilot" },
  retention: { policy: "pilot" },
};
const binding = nativeTargetAuthOnlyOwnerLinkBindingSchema.parse({
  authority,
  target,
  operationRef,
  authOnlyPlanDigest: nativeTargetAuthOnlyPlanDigest(plan),
  resourcePlanDigest,
  gatewayDeliveryPlanDigest: deliveryPlanDigest,
  gateway,
  sender: {
    issuer: "https://oidc.vercel.com/team",
    audience: "https://vercel.com/team",
    projectId: gateway.projectId,
    ownerId: target.scopeId,
    subject: "owner:team:project:gateway:environment:preview",
    environment: "preview",
  },
  browserOrigin: appBrowserOrigin,
  issuer,
  audience: operatorOrigin,
  authResourceId,
  bootstrapResource,
});
const captured = {
  audience: binding.audience,
  issuer: binding.issuer,
  authResourceId,
  browserOrigin: binding.browserOrigin,
  endpointOrigin: gateway.origin,
  bootstrapPlanDigest: resourcePlanDigest,
  organizationId: null,
  ownerSessionId: target.sessionId,
  nonceSha256: "a".repeat(64),
  expiresAt: "2026-11-06T12:01:00.000Z",
  consumedAt,
  proofRef: "saved-proof",
  proofSha256: sha256(proof),
};
const liveOwner = {
  reference: captured.proofRef,
  proof,
  oidcToken: "private-test-oidc",
  actorId: "realm-user",
  realmSessionId: "realm-session",
};
const operator = { projectId: "operator", environment: "preview" };
const jwksUrl = `${gateway.origin}/_platform/jwks.json`;
const planBase = {
  version: 1,
  action: "prepare",
  authDatabase: {
    resourceId: authResourceId,
    database: bootstrapResource.database,
    migratorRole: bootstrapResource.migratorRole,
    runtimeRole: bootstrapResource.runtimeRole,
  },
  neon: { ...bootstrapResource.neon, endpoint: bootstrapResource.hostname },
  selection: { sessionId: target.sessionId, workspaceId: authority.workspaceId },
  deploymentBoundary: {
    teamId: target.scopeId,
    operator,
    verification: { publicOrigin: issuer, gatewayOrigin: gateway.origin, jwksUrl },
  },
};
const installer = { reference: "auth-owned-organization-v1", sha256: "e".repeat(64) };
const organizationPlan = {
  ...planBase,
  authMembership: {
    kind: "create-owned-organization",
    actorId: liveOwner.actorId,
    bootstrapPlanDigest: resourcePlanDigest,
    identityCapture: { capturedAt: consumedAt, realmSessionId: liveOwner.realmSessionId },
    identityNonceSha256: captured.nonceSha256,
    identityProof: { reference: captured.proofRef, sha256: captured.proofSha256 },
    identityVerification: {
      audience: operatorOrigin,
      issuer,
      jwksUrl,
      transportSource: {
        ownerId: target.scopeId,
        projectId: operator.projectId,
        environment: "preview",
        issuer: "https://oidc.vercel.com/team",
        audience: "https://vercel.com/team",
      },
    },
    name: "Pilot",
    organizationId,
    slug: "pilot",
  },
  membershipInstaller: installer,
  effects: [{ id: "auth-membership", kind: "auth-membership", resourceId: authResourceId }],
};
const signupPlan = {
  ...planBase,
  authSignupPolicy: {
    version: 1,
    policyId: "pilot-signup",
    appId: target.appId,
    authResourceId,
    origin: issuer,
    appPath: "/app",
    organizationId,
    eligibility: "approved-email",
    allowedEmails: ["pilot@example.test"],
    membershipRole: "member",
    appRoles: [appRole],
  },
  normalActorProgram: {
    appId: target.appId,
    origin: issuer,
    organizations: [{ organizationId }],
    appAccess: [{ appId: target.appId, organizationId, roles: [appRole] }],
  },
  signupPolicyInstaller: installer,
  effects: [{ id: "auth-signup-policy", kind: "auth-signup-policy", resourceId: authResourceId }],
};
const approval = (sourceDigest: string) => ({
  requestId: `approval-${sourceDigest.slice(0, 6)}`,
  callId: `call-${sourceDigest.slice(0, 6)}`,
  planDigest: deliveryPlanDigest,
  sourceDigest,
  outcome: "approved" as const,
  publicSessionId: target.sessionId,
  responderPrincipalId: authority.ownerUserId,
  observedAt: consumedAt,
});
const effect = (approvedPlan: typeof organizationPlan | typeof signupPlan, operation: string) => {
  const approvedPlanBytes = Buffer.from(JSON.stringify(approvedPlan));
  return {
    approval: approval(sha256(approvedPlanBytes)),
    approvedPlanBytes,
    operationRef: operation,
    workerAttemptId,
    fenceGeneration: 2,
    assertCurrent: vi.fn(async () => {}),
    claimFirstDispatch: vi.fn(async () => true),
    bindWorkerContext: vi.fn(async () => async () => {}),
  };
};
const observed = (
  status: "applied" | "absent",
  operation: string,
  readbackDigest = "e".repeat(64),
) => ({
  version: 1 as const,
  status,
  operation_id: operation,
  context_digest: "b".repeat(64),
  fence_generation: 2,
  readback_sha256: readbackDigest,
});
const policyAttestation = sha256(
  JSON.stringify({ appId: target.appId, organizationId, policyDigest }),
);
type Spools = NonNullable<Parameters<typeof createNativeTargetAuthOnlyEntryPreparation>[1]>;
const orgWorker = vi.fn<Spools["organization"]>();
const policyWorker = vi.fn<Spools["signupPolicy"]>();
beforeEach(() => {
  vi.resetAllMocks();
  orgWorker.mockResolvedValue(observed("applied", organizationOperationRef));
  policyWorker.mockResolvedValue(observed("applied", signupOperationRef, policyAttestation));
});

const fixture = () => {
  const organization = effect(organizationPlan, organizationOperationRef);
  const signup = effect(signupPlan, signupOperationRef);
  const input: NativeTargetAuthOnlyAfterGatewayReadyInput = {
    authority,
    target,
    plan,
    deliveryPlan: {
      version: 1,
      kind: "native-target-auth-only-delivery",
      authOnlyPlanDigest: binding.authOnlyPlanDigest,
      resourcePlanDigest,
      target,
      source: {
        branch: plan.branch,
        gitSha: plan.publishedSource.gitSha,
        repositoryId: plan.publishedSource.repositoryId,
      },
      effects: [
        { id: "auth-only-gateway-preview", kind: "gateway-delivery" },
        { id: "auth-only-app-preview", kind: "delivery" },
      ],
      delivery: {
        action: "prepare",
        stage: "app",
        effects: [{ id: "auth-only-gateway-preview", kind: "gateway-delivery" }],
        publicGateway: {
          authBrowserOrigin: appBrowserOrigin,
          branch: gateway.branch,
          gatewayOrigin: gateway.origin,
          origin: issuer,
          projectId: gateway.projectId,
        },
      },
    },
    operationRef,
    approval: approval(deliveryPlanDigest),
    gateway,
    deliveryPlanDigest,
    fenceGeneration: 5,
    assertCurrent: vi.fn(async () => {}),
    signal: new AbortController().signal,
  };
  const ports = {
    readReadyBinding: vi.fn<Ports["readReadyBinding"]>().mockResolvedValue({
      binding,
      sandbox: {
        image: "pinned-sandbox",
        workers: {},
        teamId: target.scopeId,
        projectId: operator.projectId,
      },
    }),
    ownerLink: {
      prepare: vi.fn<Ports["ownerLink"]["prepare"]>().mockResolvedValue({
        status: "linked",
        operationRef,
        sessionId: target.sessionId,
      }),
      readCaptured: vi.fn<Ports["ownerLink"]["readCaptured"]>().mockResolvedValue(captured),
    },
    readCurrentOwnerProof: vi.fn<Ports["readCurrentOwnerProof"]>().mockResolvedValue(liveOwner),
    readCredentials: vi
      .fn<Ports["readCredentials"]>()
      .mockResolvedValue({ migrationUrl: "private-test-migrator" }),
    readApprovedOrganization: vi
      .fn<Ports["readApprovedOrganization"]>()
      .mockResolvedValue(organization),
    readApprovedSignupPolicy: vi.fn<Ports["readApprovedSignupPolicy"]>().mockResolvedValue(signup),
    readSignupPolicy: vi
      .fn<Ports["readSignupPolicy"]>()
      .mockResolvedValue({ status: "applied", policyDigest }),
  };
  return {
    input,
    ports,
    organization,
    signup,
    run: () =>
      createNativeTargetAuthOnlyEntryPreparation(ports, {
        organization: orgWorker,
        signupPolicy: policyWorker,
      })(input),
  };
};

it("returns the existing browser invitation and waits for owner consumption before reading approval or credentials", async () => {
  const { run, ports } = fixture();
  const browserUrl = "https://auth-pilot.example/auth?nonce=browser-only";
  ports.ownerLink.prepare.mockResolvedValue({
    status: "waiting-for-owner",
    operationRef,
    sessionId: target.sessionId,
    browserUrl,
    expiresAt: captured.expiresAt,
  });
  expect(await run()).toEqual({
    status: "pending-owner",
    authIdentityLink: browserUrl,
    authIdentityLinkExpiresAt: captured.expiresAt,
  });
  expect(ports.readApprovedOrganization).not.toHaveBeenCalled();
  expect(ports.readCredentials).not.toHaveBeenCalled();
  expect(orgWorker).not.toHaveBeenCalled();
});

it("validates both effects in order and projects only observed organization and policy readiness", async () => {
  const { run, ports, organization, signup } = fixture();
  orgWorker
    .mockResolvedValueOnce(observed("absent", organizationOperationRef))
    .mockResolvedValueOnce(null);
  ports.readSignupPolicy.mockResolvedValueOnce({ status: "absent" });
  policyWorker.mockResolvedValueOnce(null);
  expect(await run()).toEqual({
    status: "ready",
    organizationId,
    signupPolicyDigest: policyDigest,
  });
  expect(orgWorker.mock.calls.map(([, args]) => args.readbackOnly === true)).toEqual([
    true,
    false,
    true,
  ]);
  expect(policyWorker.mock.calls.map(([, args]) => args.readbackOnly === true)).toEqual([
    false,
    true,
  ]);
  expect(ports.readApprovedSignupPolicy.mock.invocationCallOrder[0]).toBeGreaterThan(
    orgWorker.mock.invocationCallOrder[2] ?? Number.POSITIVE_INFINITY,
  );
  expect(organization.claimFirstDispatch).toHaveBeenCalledOnce();
  expect(signup.claimFirstDispatch).toHaveBeenCalledOnce();
});

it("rechecks both installed effects without dispatching either on a later read", async () => {
  const { run, organization, signup } = fixture();
  await expect(run()).resolves.toEqual({
    status: "ready",
    organizationId,
    signupPolicyDigest: policyDigest,
  });
  expect(orgWorker.mock.calls[0]?.[1]).toMatchObject({
    readbackOnly: true,
    operationRef: organizationOperationRef,
  });
  expect(policyWorker.mock.calls[0]?.[1]).toMatchObject({
    readbackOnly: true,
    operationRef: signupOperationRef,
  });
  expect(organization.claimFirstDispatch).not.toHaveBeenCalled();
  expect(signup.claimFirstDispatch).not.toHaveBeenCalled();
});

it("denies a foreign live Realm session before credential reads or organization dispatch", async () => {
  const { run, ports } = fixture();
  ports.readCurrentOwnerProof.mockResolvedValue({
    ...liveOwner,
    realmSessionId: "foreign-session",
  });
  await expect(run()).rejects.toMatchObject({ code: "auth_identity_required" });
  expect(ports.readCredentials).not.toHaveBeenCalled();
  expect(orgWorker).not.toHaveBeenCalled();
});

it("denies unsettled or foreign approval and target mismatches without worker execution", async () => {
  const { run, ports, organization } = fixture();
  ports.readApprovedOrganization.mockResolvedValueOnce({
    ...organization,
    approval: { ...organization.approval, outcome: "cancelled" },
  });
  await expect(run()).rejects.toMatchObject({ code: "authorization_required" });
  ports.readApprovedOrganization.mockResolvedValueOnce(
    effect(
      {
        ...organizationPlan,
        selection: { ...planBase.selection, workspaceId: "foreign-workspace" },
      },
      organizationOperationRef,
    ),
  );
  await expect(run()).rejects.toMatchObject({ code: "resource_mismatch" });
  expect(orgWorker).not.toHaveBeenCalled();
});

it("keeps uncertain organization dispatches fenced against an absent retry", async () => {
  const { run, ports, organization } = fixture();
  orgWorker
    .mockResolvedValueOnce(observed("absent", organizationOperationRef))
    .mockRejectedValueOnce(new Error("uncertain worker exit"))
    .mockResolvedValueOnce(observed("absent", organizationOperationRef));
  organization.claimFirstDispatch.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await expect(run()).rejects.toThrow("uncertain worker exit");
  await expect(run()).rejects.toMatchObject({ code: "reconciliation_required" });
  expect(orgWorker.mock.calls.map(([, args]) => args.readbackOnly === true)).toEqual([
    true,
    false,
    true,
  ]);
  expect(ports.readApprovedSignupPolicy).not.toHaveBeenCalled();
});

it("blocks unknown and previously dispatched missing policy observations", async () => {
  const { run, ports, signup } = fixture();
  ports.readSignupPolicy
    .mockResolvedValueOnce({ status: "unknown" })
    .mockResolvedValueOnce({ status: "absent" });
  signup.claimFirstDispatch.mockResolvedValue(false);
  await expect(run()).rejects.toMatchObject({ code: "reconciliation_required" });
  expect(signup.claimFirstDispatch).not.toHaveBeenCalled();
  await expect(run()).rejects.toMatchObject({ code: "reconciliation_required" });
  expect(policyWorker).not.toHaveBeenCalled();
});

it("denies an applied policy digest when the pinned readback disagrees", async () => {
  const { run, ports, signup } = fixture();
  ports.readSignupPolicy.mockResolvedValue({ status: "applied", policyDigest: "b".repeat(64) });
  await expect(run()).rejects.toMatchObject({ code: "reconciliation_required" });
  expect(signup.claimFirstDispatch).not.toHaveBeenCalled();
});

it("halts before policy work when the saved delivery fence is revoked", async () => {
  const { input, run, ports, signup } = fixture();
  orgWorker.mockImplementationOnce(async () => {
    vi.mocked(input.assertCurrent).mockRejectedValue(new Error("delivery fence revoked"));
    return observed("applied", organizationOperationRef);
  });
  await expect(run()).rejects.toThrow("delivery fence revoked");
  expect(ports.readSignupPolicy).not.toHaveBeenCalled();
  expect(signup.claimFirstDispatch).not.toHaveBeenCalled();
  expect(policyWorker).not.toHaveBeenCalled();
});
