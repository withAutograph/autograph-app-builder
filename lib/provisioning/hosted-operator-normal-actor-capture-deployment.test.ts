import { describe, expect, it, vi } from "vitest";
import { generateKeyPair, exportJWK, jwtVerify, SignJWT } from "jose";
import {
  hostedOperatorPlanSchema,
  operatorPlanDigest,
  operatorRealmIdentityLinkSchema,
  projectPendingRealmIdentityLink,
} from "./hosted-operator-contract";
import {
  normalActorProgramDigest,
  normalActorProgramSchema,
  initialNormalActorState,
} from "./hosted-operator-normal-actor-program";
import { normalActorAccountPreparationSchema } from "./hosted-operator-normal-actor-journal";
import { encryptNormalActorState } from "./hosted-operator-normal-actor-state";
import {
  createNormalActorCaptureDeploymentHandler,
  createNormalActorCaptureDeploymentPorts,
} from "./hosted-operator-normal-actor-capture-deployment";
import type {
  NormalActorCaptureDeploymentResources,
  NormalActorCaptureDeploymentIo,
} from "./hosted-operator-normal-actor-capture-deployment";
import { createHostedOperatorNormalAuthTransport } from "./hosted-operator-normal-auth-transport";

const accountOperationRef = "11111111-1111-4111-8111-111111111111";
const authority = {
  issuer: "https://builder.example.com/api/auth",
  audience: "https://builder.example.com/mcp",
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
const context = {
  authority,
  target,
  ownerContext: {
    kind: "direct" as const,
    adapterGeneration: 1,
    adapterSessionId: "adapter",
    authority,
    principal: { ...authority, scopes: ["autograph:get"] },
    sessionId: target.sessionId,
  },
};
const program = normalActorProgramSchema.parse({
  version: 1,
  appId: target.appId,
  origin: "https://apps.example.com",
  actors: [
    { actorKey: "owner", email: "owner@example.com", name: "Owner", account: "capture-existing" },
  ],
  organizations: [],
  memberships: [],
  appAccess: [],
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
      gatewayOrigin: "https://gateway.example.com",
      jwksUrl: "https://gateway.example.com/_platform/jwks.json",
      publicOrigin: program.origin,
    },
  },
});
const preparationInput = {
  program,
  programDigest: normalActorProgramDigest(program),
  accountOperationRef,
  accountPlan: plan,
  accountPlanDigest: operatorPlanDigest(plan),
  accountApprovalId: "initial-approval",
  accountApprovedByCallId: "initial-call",
};
const normalCookie = {
  name: "__Secure-session",
  value: "actual%2Fencoded%3Dcookie",
  domain: "apps.example.com",
  path: "/",
  expires: -1 as const,
  httpOnly: true as const,
  secure: true as const,
  sameSite: "Lax" as const,
  hostOnly: true,
};

const worker = {
  executablePath: "/fixture/worker",
  id: "worker",
  sha256: "f".repeat(64),
  operationScope: "generated-app-access-v1" as const,
  subcommand: "protected-generated-app-access" as const,
};
const operatorPolicy = {
  issuer: "https://oidc.vercel.com/team",
  audience: "https://vercel.com/team",
  ownerId: "team",
  projectId: "prj_operator",
  environment: "preview" as const,
};
const configuration: NormalActorCaptureDeploymentResources["configuration"] = {
  applications: {
    "normal-app": {
      accessRoles: ["member"],
      appDatabase: plan.appDatabase,
      branch: target.branch,
      projectId: target.projectId,
    },
  },
  authDatabase: plan.authDatabase,
  builderCallbackOrigin: "https://builder.example.com",
  catalogAppIds: ["normal-app"],
  gateway: {
    authBrowserOrigin: program.origin,
    branch: target.branch,
    environment: "preview",
    gatewayOrigin: "https://gateway.example.com",
    gitSha: "a".repeat(40),
    projectId: "prj_gateway",
    protectedApplicationIds: ["normal-app"],
    publicOrigin: program.origin,
    repoId: "gateway-repo",
    workload: { ...operatorPolicy, projectId: "prj_gateway", subject: "gateway-subject" },
  },
  operator: {
    deploymentId: "dpl_operator",
    environment: "preview",
    origin: "https://operator.example.com",
    projectId: "prj_operator",
  },
  workloadPolicy: {
    ...operatorPolicy,
    projectId: "prj_builder",
    environment: "production",
    subject: "builder-subject",
  },
  nativeNeon: {
    configuration: {
      connector: "native",
      nativeStore: {
        configurationId: "cfg",
        resourceId: "neon-resource",
        sourceProjectId: "prj_operator",
      },
      operator: operatorPolicy,
    },
    scope: {
      branchId: "br-fixture",
      endpointId: "ep-fixture",
      hostname: "ep-owned.neon.tech",
      maintenanceDatabase: "postgres",
      maintenanceRole: "owner",
      projectId: "neon-owned",
    },
  },
  sandbox: {
    image: "fixture-image",
    teamId: "team",
    projectId: "prj_operator",
    accessWorker: worker,
    resourcesWorker: worker,
    authWorker: worker,
    authProposal: { executablePath: "/fixture/proposal", id: "proposal", sha256: "a".repeat(64) },
    workers: {},
  },
  teamId: "team",
};
const preparation = normalActorAccountPreparationSchema.parse({
  ...preparationInput,
  sealedState: encryptNormalActorState({
    authority,
    ownerSessionId: target.sessionId,
    operationRef: accountOperationRef,
    program,
    config: { tokenKey: Buffer.alloc(32, 7), tokenKeyVersion: "v1" },
    state: initialNormalActorState(program, accountOperationRef),
  }),
  captures: [],
});
const link = operatorRealmIdentityLinkSchema.parse({
  audience: configuration.builderCallbackOrigin,
  authResourceId: "auth-resource",
  bootstrapPlanDigest: preparation.accountPlanDigest,
  browserSession: {
    operationRef: accountOperationRef,
    participantProgramDigest: preparation.programDigest,
  },
  browserOrigin: program.origin,
  endpointOrigin: "https://gateway.example.com",
  expiresAt: "2030-01-01T00:00:00.000Z",
  issuer: program.origin,
  nonceSha256: "e".repeat(64),
  organizationId: null,
  ownerSessionId: target.sessionId,
});
const resource = {
  version: 1 as const,
  database: "auth",
  environment: "preview" as const,
  hostname: "ep-owned.neon.tech",
  migratorRole: "auth_owner",
  runtimeRole: "auth_runtime",
  port: 5432 as const,
  schema: "public" as const,
  neon: { branchId: "br_fixture", projectId: "neon-owned" },
};
const fixture = () => {
  const noOp = vi.fn(async () => {
    await Promise.resolve();
  });
  const capture = { context, preparation, actorKey: "owner", organizationId: undefined, link };
  const readPending = vi.fn(async () => await Promise.resolve(capture));
  const readStaging = vi.fn(
    async () =>
      await Promise.resolve({
        link: projectPendingRealmIdentityLink(link),
        bootstrapResource: resource,
        jwksUrl: `${link.endpointOrigin}/_platform/jwks.json`,
      }),
  );
  const resources: NormalActorCaptureDeploymentResources = {
    configuration: structuredClone(configuration),
    controlPlane: {
      normalActorJournalPorts: {
        keyring: { tokenKey: Buffer.alloc(32, 7), tokenKeyVersion: "v1" },
        now: Date.now,
        assertAuthorized: noOp,
        assertAccountApproval: noOp,
        assertMutationAuthority: noOp,
        store: {
          read: async () => {
            await Promise.resolve();
            // oxlint-disable-next-line unicorn/no-useless-undefined -- The actual journal port distinguishes an absent row or lost CAS from a void result.
            return undefined;
          },
          compareAndSet: async () => {
            await Promise.resolve();
            // oxlint-disable-next-line unicorn/no-useless-undefined -- The actual journal port distinguishes an absent row or lost CAS from a void result.
            return undefined;
          },
        },
      },
      assertPlanningAuthorized: noOp,
      readPendingNormalActorCapture: readPending,
      readPendingRealmIdentityLinkForStaging: readStaging,
      close: noOp,
    },
  };
  const authFetch = vi.fn<typeof fetch>(
    async () =>
      await Promise.resolve(
        Response.json({
          session: {
            id: "actual-session",
            userId: "actual-actor",
            expiresAt: "2030-01-01T00:00:00.000Z",
          },
          user: { id: "actual-actor", email: program.actors[0]?.email },
        }),
      ),
  );
  const normalTransport = vi.fn<NonNullable<NormalActorCaptureDeploymentIo["normalTransport"]>>(
    async (input) =>
      await createHostedOperatorNormalAuthTransport(input, {
        getOidc: async () => await Promise.resolve("native-token"),
        verifyOidc: async () => {
          await Promise.resolve();
        },
        fetch: authFetch,
      }),
  );
  return { resources, readPending, readStaging, noOp, normalTransport, authFetch };
};

describe("native normal capture deployment assembly", () => {
  it("verifies native sender signature and exact configured claims including its subject", async () => {
    const f = fixture();
    const keys = await generateKeyPair("RS256");
    const sender = configuration.gateway.workload;
    const token = await new SignJWT({
      owner_id: sender.ownerId,
      project_id: sender.projectId,
      environment: sender.environment,
    })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(sender.issuer)
      .setAudience(sender.audience)
      .setSubject(sender.subject)
      .setIssuedAt()
      .setExpirationTime("2m")
      .sign(keys.privateKey);
    const verifyNativeToken = vi.fn<
      NonNullable<NormalActorCaptureDeploymentIo["verifyNativeToken"]>
    >(async (incoming, options) => await jwtVerify(incoming, keys.publicKey, options));
    const ports = createNormalActorCaptureDeploymentPorts(f.resources, { verifyNativeToken });
    expect(await ports.verifySender(token, ports.sender)).toEqual({
      iss: sender.issuer,
      aud: sender.audience,
      owner_id: sender.ownerId,
      project_id: sender.projectId,
      environment: sender.environment,
      sub: sender.subject,
    });
    expect(verifyNativeToken).toHaveBeenCalledWith(token, {
      audience: sender.audience,
      issuer: sender.issuer,
      ownerId: sender.ownerId,
      projectId: sender.projectId,
      environment: sender.environment,
      subject: sender.subject,
    });
    const wrongSubject = await new SignJWT({
      owner_id: sender.ownerId,
      project_id: sender.projectId,
      environment: sender.environment,
    })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(sender.issuer)
      .setAudience(sender.audience)
      .setSubject("different-sender")
      .setIssuedAt()
      .setExpirationTime("2m")
      .sign(keys.privateKey);
    await expect(ports.verifySender(wrongSubject, ports.sender)).rejects.toThrow();
  });
  it("pins proof keys and readback to the canonical Gateway candidate with native Builder transport", async () => {
    const f = fixture();
    const keys = await generateKeyPair("EdDSA");
    const key = { ...(await exportJWK(keys.publicKey)), kid: "actual-key", alg: "EdDSA" };
    const remote = vi.fn<typeof fetch>(
      async () => await Promise.resolve(Response.json({ keys: [key] })),
    );
    const realmTransport = vi.fn<NonNullable<NormalActorCaptureDeploymentIo["realmTransport"]>>(
      () => remote,
    );
    const ports = createNormalActorCaptureDeploymentPorts(f.resources, { realmTransport });
    const selector = { ownerSessionId: target.sessionId, nonceSha256: link.nonceSha256 };
    const pending = await ports.pending(selector);
    expect(f.readPending).toHaveBeenCalledWith(selector);
    expect(f.readStaging).toHaveBeenCalledWith(selector);
    expect(realmTransport).toHaveBeenCalledWith(
      f.resources.configuration,
      "builder",
      undefined,
      link.endpointOrigin,
    );
    expect(pending.resource).toEqual(resource);
    const proof = await new SignJWT({ actual: true })
      .setProtectedHeader({ alg: "EdDSA", kid: "actual-key" })
      .sign(keys.privateKey);
    const verified = await jwtVerify(proof, pending.getKey);
    expect(verified.payload.actual).toBe(true);
    await pending.readback(
      new Request(`${link.endpointOrigin}/api/auth/platform/operator-identity/readback`, {
        method: "POST",
        body: "{}",
      }),
    );
    expect(remote).toHaveBeenCalledTimes(2);
    await pending.assertCurrent();
    f.readPending.mockResolvedValueOnce({
      context,
      preparation,
      actorKey: "different",
      organizationId: undefined,
      link,
    });
    await expect(pending.assertCurrent()).rejects.toThrow(
      "realm_browser_session_capture_unavailable",
    );
  });
  it.each([true, false])(
    "checks the actual captured cookie through normal GetSession, hostOnly=%s",
    async (hostOnly) => {
      const f = fixture();
      const ports = createNormalActorCaptureDeploymentPorts(f.resources, {
        normalTransport: f.normalTransport,
      });
      const cookie = {
        ...normalCookie,
        hostOnly,
        domain: hostOnly ? normalCookie.domain : "example.com",
      };
      const session = await ports.verifyCapturedActor({
        context,
        actorKey: "owner",
        program,
        session: {
          reference: "22222222-2222-4222-8222-222222222222",
          actorId: "actual-actor",
          realmSessionId: "actual-session",
          origin: program.origin,
          expiresAt: "2030-01-01T00:00:00.000Z",
        },
        normalCookie: cookie,
      });
      expect(session?.sessionId).toBe("actual-session");
      expect(f.normalTransport.mock.calls[0]?.[0]?.sourceHost).toBe("builder");
      const [request] = f.authFetch.mock.calls;
      expect(request?.[0]).toEqual(
        new URL(
          `${program.origin}/api/auth/get-session?disableRefresh=true&disableCookieCache=true`,
        ),
      );
      expect(new Headers(request?.[1]?.headers).get("cookie")).toBe(
        `${normalCookie.name}=${normalCookie.value}`,
      );
      expect(new Headers(request?.[1]?.headers).get("x-vercel-trusted-oidc-idp-token")).toBe(
        "native-token",
      );
      expect(cookie.domain).toBe(hostOnly ? "apps.example.com" : "example.com");
    },
  );
  it("rejects a sender or canonical proof endpoint belonging to another Gateway", async () => {
    const f = fixture();
    f.resources.configuration.gateway.workload.projectId = "other-gateway";
    expect(() => createNormalActorCaptureDeploymentPorts(f.resources)).toThrow();
    const second = fixture();
    second.readStaging.mockResolvedValueOnce({
      link: projectPendingRealmIdentityLink(link),
      bootstrapResource: resource,
      jwksUrl: "https://other.example.com/_platform/jwks.json",
    });
    await expect(
      createNormalActorCaptureDeploymentPorts(second.resources).pending({
        ownerSessionId: target.sessionId,
        nonceSha256: link.nonceSha256,
      }),
    ).rejects.toThrow("realm_browser_session_capture_unavailable");
  });
  it("closes resources and returns only the closed capture error on unauthorized route requests", async () => {
    const f = fixture();
    const openResources = vi.fn(async () => await Promise.resolve(f.resources));
    const response = await createNormalActorCaptureDeploymentHandler(
      {},
      { openResources },
    )(
      new Request(
        `${configuration.builderCallbackOrigin}/api/hosted-operator/realm-browser-session`,
        { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
      ),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "realm_browser_session_capture_unavailable" });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(f.resources.controlPlane.close).toHaveBeenCalledOnce();
    expect(f.readPending).not.toHaveBeenCalled();
  });
});
