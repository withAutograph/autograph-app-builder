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
  audience: "https://builder.example/mcp",
  issuer: "https://builder.example/api/auth",
  ownerUserId: "owner",
  workspaceId: "workspace",
};
const target = {
  appId: "signup-pilot",
  branch: "pilot",
  environment: "preview" as const,
  installationId: "install",
  projectId: "app",
  scopeId: "team",
  scopeType: "team" as const,
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
  branch: "gateway-pilot",
  deploymentId: "deployment",
  operationRef,
  origin: "https://immutable-gateway.example",
  projectId: "gateway",
  readyState: "READY" as const,
  repoId: "gateway-repo",
};
const bootstrapResource = {
  database: "pilot_auth",
  environment: "preview",
  hostname: "ep-pilot.neon.tech",
  migratorRole: "pilot_migrator",
  neon: { branchId: "br-pilot", projectId: "neon-pilot" },
  port: 5432,
  runtimeRole: "pilot_runtime",
  schema: "public",
  version: 1,
};
const appRole = "pilot_user";
const issuer = "https://signup-pilot.example";
const appBrowserOrigin = "https://auth-pilot.example";
const operatorOrigin = "https://operator-pilot.example";
const authResourceId = "isolated-auth";
const organizationId = "owner-organization";
const plan: NativeTargetAuthOnlyPlan = {
  appId: target.appId,
  appRole,
  authResource: {
    authorityDigest: "a".repeat(64),
    database: bootstrapResource.database,
    endpointId: "ep-pilot",
    hostname: bootstrapResource.hostname,
    profileId: "pilot-profile",
    resourceId: authResourceId,
  },
  authSchema: {
    artifactRef: "auth-schema",
    installer: { reference: "auth-schema", sha256: "c".repeat(64) },
    planDigest: "a".repeat(64),
    targetDigest: "b".repeat(64),
  },
  branch: target.branch,
  cost: { description: "pilot", ownership: "current-owner" },
  kind: "native-target-auth-only",
  origin: {
    adapterGeneration: 1,
    adapterSessionId: "adapter-session",
    appSpecDigest: "a".repeat(64),
    authority,
    capturedDescription: { appId: target.appId, kind: "static", sha256: "b".repeat(64) },
    publicSessionId: target.sessionId,
  },
  project: {
    installationId: target.installationId,
    name: "signup-pilot",
    projectSettings: { rootDirectory: "apps/pilot" },
    protection: {
      oidcTokenConfig: { enabled: true, issuerMode: "team" },
      ssoProtection: { deploymentType: "all" },
    },
    teamId: target.scopeId,
  },
  publishedSource: {
    branch: target.branch,
    changeSetDigest: "c".repeat(64),
    gitSha: "a".repeat(40),
    gitTree: "b".repeat(40),
    repositoryId: "app-repo",
    reviewDigest: "d".repeat(64),
  },
  retention: { policy: "pilot" },
  signupPolicy: { eligibility: "approved-email-list", requireVerifiedEmail: true },
  version: 1,
};
const binding = nativeTargetAuthOnlyOwnerLinkBindingSchema.parse({
  audience: operatorOrigin,
  authOnlyPlanDigest: nativeTargetAuthOnlyPlanDigest(plan),
  authResourceId,
  authority,
  bootstrapResource,
  browserOrigin: appBrowserOrigin,
  gateway,
  gatewayDeliveryPlanDigest: deliveryPlanDigest,
  issuer,
  operationRef,
  resourcePlanDigest,
  sender: {
    audience: "https://vercel.com/team",
    environment: "preview",
    issuer: "https://oidc.vercel.com/team",
    ownerId: target.scopeId,
    projectId: gateway.projectId,
    subject: "owner:team:project:gateway:environment:preview",
  },
  target,
});
const captured = {
  audience: binding.audience,
  authResourceId,
  bootstrapPlanDigest: resourcePlanDigest,
  browserOrigin: binding.browserOrigin,
  consumedAt,
  endpointOrigin: gateway.origin,
  expiresAt: "2026-11-06T12:01:00.000Z",
  issuer: binding.issuer,
  nonceSha256: "a".repeat(64),
  organizationId: null,
  ownerSessionId: target.sessionId,
  proofRef: "saved-proof",
  proofSha256: sha256(proof),
};
const liveOwner = {
  actorId: "realm-user",
  oidcToken: "private-test-oidc",
  proof,
  realmSessionId: "realm-session",
  reference: captured.proofRef,
};
const operator = { environment: "preview", projectId: "operator" };
const jwksUrl = `${gateway.origin}/_platform/jwks.json`;
const planBase = {
  action: "prepare",
  authDatabase: {
    database: bootstrapResource.database,
    migratorRole: bootstrapResource.migratorRole,
    resourceId: authResourceId,
    runtimeRole: bootstrapResource.runtimeRole,
  },
  deploymentBoundary: {
    operator,
    teamId: target.scopeId,
    verification: { gatewayOrigin: gateway.origin, jwksUrl, publicOrigin: issuer },
  },
  neon: { ...bootstrapResource.neon, endpoint: bootstrapResource.hostname },
  selection: { sessionId: target.sessionId, workspaceId: authority.workspaceId },
  version: 1,
};
const installer = { reference: "auth-owned-organization-v1", sha256: "e".repeat(64) };
const organizationPlan = {
  ...planBase,
  authMembership: {
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
        audience: "https://vercel.com/team",
        environment: "preview",
        issuer: "https://oidc.vercel.com/team",
        ownerId: target.scopeId,
        projectId: operator.projectId,
      },
    },
    kind: "create-owned-organization",
    name: "Pilot",
    organizationId,
    slug: "pilot",
  },
  effects: [{ id: "auth-membership", kind: "auth-membership", resourceId: authResourceId }],
  membershipInstaller: installer,
};
const signupPlan = {
  ...planBase,
  authSignupPolicy: {
    allowedEmails: ["pilot@example.test"],
    appId: target.appId,
    appPath: "/app",
    appRoles: [appRole],
    authResourceId,
    eligibility: "approved-email",
    membershipRole: "member",
    organizationId,
    origin: issuer,
    policyId: "pilot-signup",
    version: 1,
  },
  effects: [{ id: "auth-signup-policy", kind: "auth-signup-policy", resourceId: authResourceId }],
  normalActorProgram: {
    appAccess: [{ appId: target.appId, organizationId, roles: [appRole] }],
    appId: target.appId,
    organizations: [{ organizationId }],
    origin: issuer,
  },
  signupPolicyInstaller: installer,
};
const approval = (sourceDigest: string) => ({
  callId: `call-${sourceDigest.slice(0, 6)}`,
  observedAt: consumedAt,
  outcome: "approved" as const,
  planDigest: deliveryPlanDigest,
  publicSessionId: target.sessionId,
  requestId: `approval-${sourceDigest.slice(0, 6)}`,
  responderPrincipalId: authority.ownerUserId,
  sourceDigest,
});
const effect = (approvedPlan: typeof organizationPlan | typeof signupPlan, operation: string) => {
  const approvedPlanBytes = Buffer.from(JSON.stringify(approvedPlan));
  return {
    approval: approval(sha256(approvedPlanBytes)),
    approvedPlanBytes,
    assertCurrent: vi.fn(async () => {}),
    bindWorkerContext: vi.fn(async () => async () => {}),
    claimFirstDispatch: vi.fn(async () => true),
    fenceGeneration: 2,
    operationRef: operation,
    workerAttemptId,
  };
};
const observed = (
  status: "applied" | "absent",
  operation: string,
  readbackDigest = "e".repeat(64),
) => ({
  context_digest: "b".repeat(64),
  fence_generation: 2,
  operation_id: operation,
  readback_sha256: readbackDigest,
  status,
  version: 1 as const,
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
    approval: approval(deliveryPlanDigest),
    assertCurrent: vi.fn(async () => {}),
    authority,
    deliveryPlan: {
      authOnlyPlanDigest: binding.authOnlyPlanDigest,
      delivery: {
        action: "prepare",
        effects: [{ id: "auth-only-gateway-preview", kind: "gateway-delivery" }],
        publicGateway: {
          authBrowserOrigin: appBrowserOrigin,
          branch: gateway.branch,
          gatewayOrigin: gateway.origin,
          origin: issuer,
          projectId: gateway.projectId,
        },
        stage: "app",
      },
      effects: [
        { id: "auth-only-gateway-preview", kind: "gateway-delivery" },
        { id: "auth-only-app-preview", kind: "delivery" },
      ],
      kind: "native-target-auth-only-delivery",
      resourcePlanDigest,
      source: {
        branch: plan.branch,
        gitSha: plan.publishedSource.gitSha,
        repositoryId: plan.publishedSource.repositoryId,
      },
      target,
      version: 1,
    },
    deliveryPlanDigest,
    fenceGeneration: 5,
    gateway,
    operationRef,
    plan,
    signal: new AbortController().signal,
    target,
  };
  const ports = {
    ownerLink: {
      prepare: vi.fn<Ports["ownerLink"]["prepare"]>().mockResolvedValue({
        status: "linked",
        operationRef,
        sessionId: target.sessionId,
      }),
      readCaptured: vi.fn<Ports["ownerLink"]["readCaptured"]>().mockResolvedValue(captured),
    },
    readApprovedOrganization: vi
      .fn<Ports["readApprovedOrganization"]>()
      .mockResolvedValue(organization),
    readApprovedSignupPolicy: vi.fn<Ports["readApprovedSignupPolicy"]>().mockResolvedValue(signup),
    readCredentials: vi
      .fn<Ports["readCredentials"]>()
      .mockResolvedValue({ migrationUrl: "private-test-migrator" }),
    readCurrentOwnerProof: vi.fn<Ports["readCurrentOwnerProof"]>().mockResolvedValue(liveOwner),
    readReadyBinding: vi.fn<Ports["readReadyBinding"]>().mockResolvedValue({
      binding,
      sandbox: {
        image: "pinned-sandbox",
        workers: {},
        teamId: target.scopeId,
        projectId: operator.projectId,
      },
    }),
    readSignupPolicy: vi
      .fn<Ports["readSignupPolicy"]>()
      .mockResolvedValue({ status: "applied", policyDigest }),
  };
  return {
    input,
    organization,
    ports,
    run: async () =>
      await createNativeTargetAuthOnlyEntryPreparation(ports, {
        organization: orgWorker,
        signupPolicy: policyWorker,
      })(input),
    signup,
  };
};

it("returns the existing browser invitation and waits for owner consumption before reading approval or credentials", async () => {
  const { run, ports } = fixture();
  const browserUrl = "https://auth-pilot.example/auth?nonce=browser-only";
  ports.ownerLink.prepare.mockResolvedValue({
    browserUrl,
    expiresAt: captured.expiresAt,
    operationRef,
    sessionId: target.sessionId,
    status: "waiting-for-owner",
  });
  expect(await run()).toEqual({
    authIdentityLink: browserUrl,
    authIdentityLinkExpiresAt: captured.expiresAt,
    status: "pending-owner",
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
    organizationId,
    signupPolicyDigest: policyDigest,
    status: "ready",
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
    organizationId,
    signupPolicyDigest: policyDigest,
    status: "ready",
  });
  expect(orgWorker.mock.calls[0]?.[1]).toMatchObject({
    operationRef: organizationOperationRef,
    readbackOnly: true,
  });
  expect(policyWorker.mock.calls[0]?.[1]).toMatchObject({
    operationRef: signupOperationRef,
    readbackOnly: true,
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
  ports.readSignupPolicy.mockResolvedValue({ policyDigest: "b".repeat(64), status: "applied" });
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
