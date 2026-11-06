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
  audience: "https://builder.example.com/mcp",
  issuer: "https://builder.example.com/api/auth",
  ownerUserId: "owner",
  workspaceId: "workspace",
};
const target = {
  appId: "normal-app",
  branch: "preview",
  environment: "preview" as const,
  installationId: "installation",
  projectId: "prj_app",
  scopeId: "team",
  scopeType: "team" as const,
  sessionId: "owner-session",
};
const context = {
  authority,
  ownerContext: {
    adapterGeneration: 1,
    adapterSessionId: "adapter",
    authority,
    kind: "direct" as const,
    principal: { ...authority, scopes: ["autograph:get"] },
    sessionId: target.sessionId,
  },
  target,
};
const program = normalActorProgramSchema.parse({
  actors: [
    { account: "capture-existing", actorKey: "owner", email: "owner@example.com", name: "Owner" },
  ],
  appAccess: [],
  appId: target.appId,
  memberships: [],
  organizations: [],
  origin: "https://apps.example.com",
  version: 1,
});
const plan = hostedOperatorPlanSchema.parse({
  access: [],
  action: "prepare",
  appDatabase: {
    database: "normal",
    migratorRole: "normal_owner",
    resourceId: "app-resource",
    runtimeRole: "normal_runtime",
  },
  authDatabase: {
    database: "auth",
    migratorRole: "auth_owner",
    resourceId: "auth-resource",
    runtimeRole: "auth_runtime",
  },
  contextId: "accepted-spec",
  cost: { class: "shared-recovery-group", description: "Approved normal accounts", owner: "owner" },
  deploymentBoundary: {
    app: {
      branch: target.branch,
      deploymentId: "dpl_app",
      environment: "preview",
      projectId: target.projectId,
    },
    authority,
    gateway: {
      branch: target.branch,
      deploymentId: "dpl_gateway",
      environment: "preview",
      projectId: "prj_gateway",
    },
    operator: { deploymentId: "dpl_operator", environment: "preview", projectId: "prj_operator" },
    teamId: "team",
    verification: {
      gatewayOrigin: "https://gateway.example.com",
      jwksUrl: "https://gateway.example.com/_platform/jwks.json",
      publicOrigin: program.origin,
    },
  },
  effects: [
    {
      description: "Capture approved actual accounts",
      id: "normal-accounts",
      kind: "normal-accounts",
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
  normalActorProgram: program,
  publicGateway: { branch: target.branch, origin: program.origin, projectId: "prj_gateway" },
  release: { artifactRef: "owned-release", id: "release", sha256: "b".repeat(64) },
  retention: { expiresAt: "2030-01-01T00:00:00.000Z", policy: "Retain Auth" },
  selection: {
    appId: target.appId,
    branch: target.branch,
    environment: target.environment,
    projectId: target.projectId,
    sessionId: target.sessionId,
  },
  stage: "auth-participants",
  version: 1,
});
const preparationInput = {
  accountApprovalId: "initial-approval",
  accountApprovedByCallId: "initial-call",
  accountOperationRef,
  accountPlan: plan,
  accountPlanDigest: operatorPlanDigest(plan),
  program,
  programDigest: normalActorProgramDigest(program),
};
const normalCookie = {
  domain: "apps.example.com",
  expires: -1 as const,
  hostOnly: true,
  httpOnly: true as const,
  name: "__Secure-session",
  path: "/",
  sameSite: "Lax" as const,
  secure: true as const,
  value: "actual%2Fencoded%3Dcookie",
};

const worker = {
  executablePath: "/fixture/worker",
  id: "worker",
  operationScope: "generated-app-access-v1" as const,
  sha256: "f".repeat(64),
  subcommand: "protected-generated-app-access" as const,
};
const operatorPolicy = {
  audience: "https://vercel.com/team",
  environment: "preview" as const,
  issuer: "https://oidc.vercel.com/team",
  ownerId: "team",
  projectId: "prj_operator",
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
  operator: {
    deploymentId: "dpl_operator",
    environment: "preview",
    origin: "https://operator.example.com",
    projectId: "prj_operator",
  },
  sandbox: {
    accessWorker: worker,
    authProposal: { executablePath: "/fixture/proposal", id: "proposal", sha256: "a".repeat(64) },
    authWorker: worker,
    image: "fixture-image",
    projectId: "prj_operator",
    resourcesWorker: worker,
    teamId: "team",
    workers: {},
  },
  teamId: "team",
  workloadPolicy: {
    ...operatorPolicy,
    environment: "production",
    projectId: "prj_builder",
    subject: "builder-subject",
  },
};
const preparation = normalActorAccountPreparationSchema.parse({
  ...preparationInput,
  captures: [],
  sealedState: encryptNormalActorState({
    authority,
    config: { tokenKey: Buffer.alloc(32, 7), tokenKeyVersion: "v1" },
    operationRef: accountOperationRef,
    ownerSessionId: target.sessionId,
    program,
    state: initialNormalActorState(program, accountOperationRef),
  }),
});
const link = operatorRealmIdentityLinkSchema.parse({
  audience: configuration.builderCallbackOrigin,
  authResourceId: "auth-resource",
  bootstrapPlanDigest: preparation.accountPlanDigest,
  browserOrigin: program.origin,
  browserSession: {
    operationRef: accountOperationRef,
    participantProgramDigest: preparation.programDigest,
  },
  endpointOrigin: "https://gateway.example.com",
  expiresAt: "2030-01-01T00:00:00.000Z",
  issuer: program.origin,
  nonceSha256: "e".repeat(64),
  organizationId: null,
  ownerSessionId: target.sessionId,
});
const resource = {
  database: "auth",
  environment: "preview" as const,
  hostname: "ep-owned.neon.tech",
  migratorRole: "auth_owner",
  neon: { branchId: "br_fixture", projectId: "neon-owned" },
  port: 5432 as const,
  runtimeRole: "auth_runtime",
  schema: "public" as const,
  version: 1 as const,
};
const fixture = () => {
  const noOp = vi.fn(async () => {
    await Promise.resolve();
  });
  const capture = { actorKey: "owner", context, link, organizationId: undefined, preparation };
  const readPending = vi.fn(async () => await Promise.resolve(capture));
  const readStaging = vi.fn(
    async () =>
      await Promise.resolve({
        bootstrapResource: resource,
        jwksUrl: `${link.endpointOrigin}/_platform/jwks.json`,
        link: projectPendingRealmIdentityLink(link),
      }),
  );
  const resources: NormalActorCaptureDeploymentResources = {
    configuration: structuredClone(configuration),
    controlPlane: {
      assertPlanningAuthorized: noOp,
      close: noOp,
      normalActorJournalPorts: {
        assertAccountApproval: noOp,
        assertAuthorized: noOp,
        assertMutationAuthority: noOp,
        keyring: { tokenKey: Buffer.alloc(32, 7), tokenKeyVersion: "v1" },
        now: Date.now,
        store: {
          compareAndSet: async () => {
            await Promise.resolve();
            // oxlint-disable-next-line unicorn/no-useless-undefined -- The actual journal port distinguishes an absent row or lost CAS from a void result.
            return undefined;
          },
          read: async () => {
            await Promise.resolve();
            // oxlint-disable-next-line unicorn/no-useless-undefined -- The actual journal port distinguishes an absent row or lost CAS from a void result.
            return undefined;
          },
        },
      },
      readPendingNormalActorCapture: readPending,
      readPendingRealmIdentityLinkForStaging: readStaging,
      resolveRealmIdentityCallbackOwnerContext: vi.fn(async () => {
        throw new Error("unexpected public route");
      }),
    },
  };
  const authFetch = vi.fn<typeof fetch>(
    async () =>
      await Promise.resolve(
        Response.json({
          session: {
            expiresAt: "2030-01-01T00:00:00.000Z",
            id: "actual-session",
            userId: "actual-actor",
          },
          user: { email: program.actors[0]?.email, id: "actual-actor" },
        }),
      ),
  );
  const normalTransport = vi.fn<NonNullable<NormalActorCaptureDeploymentIo["normalTransport"]>>(
    async (input) =>
      await createHostedOperatorNormalAuthTransport(input, {
        fetch: authFetch,
        getOidc: async () => await Promise.resolve("native-token"),
        verifyOidc: async () => {
          await Promise.resolve();
        },
      }),
  );
  return { authFetch, noOp, normalTransport, readPending, readStaging, resources };
};

describe("native normal capture deployment assembly", () => {
  it("verifies native sender signature and exact configured claims including its subject", async () => {
    const f = fixture();
    const keys = await generateKeyPair("RS256");
    const sender = configuration.gateway.workload;
    const token = await new SignJWT({
      environment: sender.environment,
      owner_id: sender.ownerId,
      project_id: sender.projectId,
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
      aud: sender.audience,
      environment: sender.environment,
      iss: sender.issuer,
      owner_id: sender.ownerId,
      project_id: sender.projectId,
      sub: sender.subject,
    });
    expect(verifyNativeToken).toHaveBeenCalledWith(token, {
      audience: sender.audience,
      environment: sender.environment,
      issuer: sender.issuer,
      ownerId: sender.ownerId,
      projectId: sender.projectId,
      subject: sender.subject,
    });
    const wrongSubject = await new SignJWT({
      environment: sender.environment,
      owner_id: sender.ownerId,
      project_id: sender.projectId,
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
    const key = { ...(await exportJWK(keys.publicKey)), alg: "EdDSA", kid: "actual-key" };
    const remote = vi.fn<typeof fetch>(
      async () => await Promise.resolve(Response.json({ keys: [key] })),
    );
    const realmTransport = vi.fn<NonNullable<NormalActorCaptureDeploymentIo["realmTransport"]>>(
      () => remote,
    );
    const ports = createNormalActorCaptureDeploymentPorts(f.resources, { realmTransport });
    const selector = { nonceSha256: link.nonceSha256, ownerSessionId: target.sessionId };
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
        body: "{}",
        method: "POST",
      }),
    );
    expect(remote).toHaveBeenCalledTimes(2);
    await pending.assertCurrent();
    f.readPending.mockResolvedValueOnce({
      actorKey: "different",
      context,
      link,
      organizationId: undefined,
      preparation,
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
        domain: hostOnly ? normalCookie.domain : "example.com",
        hostOnly,
      };
      const session = await ports.verifyCapturedActor({
        actorKey: "owner",
        context,
        normalCookie: cookie,
        program,
        session: {
          actorId: "actual-actor",
          expiresAt: "2030-01-01T00:00:00.000Z",
          origin: program.origin,
          realmSessionId: "actual-session",
          reference: "22222222-2222-4222-8222-222222222222",
        },
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
      bootstrapResource: resource,
      jwksUrl: "https://other.example.com/_platform/jwks.json",
      link: projectPendingRealmIdentityLink(link),
    });
    await expect(
      createNormalActorCaptureDeploymentPorts(second.resources).pending({
        nonceSha256: link.nonceSha256,
        ownerSessionId: target.sessionId,
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
        { body: "{}", headers: { "content-type": "application/json" }, method: "POST" },
      ),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "realm_browser_session_capture_unavailable" });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(f.resources.controlPlane.close).toHaveBeenCalledOnce();
    expect(f.readPending).not.toHaveBeenCalled();
  });
});

it("uses the canonical enrolled Production sender without relabeling the Preview workload", async () => {
  const f = fixture();
  const legacySender = structuredClone(f.resources.configuration.gateway.workload);
  const sender = {
    ...legacySender,
    environment: "production" as const,
    subject: "native-production-subject",
  };
  const signing = await generateKeyPair("EdDSA");
  const key = await exportJWK(signing.publicKey);
  if (key.x === undefined) {
    throw new Error("missing public key");
  }
  f.resources.publicRealm = {
    binding: {
      enrollmentRef: "11111111-1111-4111-a111-111111111111",
      operationRef: accountOperationRef,
      planDigest: "b".repeat(64),
    },
    enrollment: {
      appId: target.appId,
      authority,
      enrollmentRef: "11111111-1111-4111-a111-111111111111",
      kind: "public-isolated-realm-v1",
      ownerSessionId: target.sessionId,
      project: { environment: "production", ownerId: sender.ownerId, projectId: sender.projectId },
      publicOrigin: program.origin,
      resource,
      sourceBootstrap: {
        authResourceId: "auth-resource",
        operationRef: accountOperationRef,
        planDigest: "b".repeat(64),
      },
      version: 1,
    },
    publicJwk: {
      alg: "EdDSA",
      crv: "Ed25519",
      kid: "public-own-app",
      kty: "OKP",
      use: "sig",
      x: key.x,
    },
    sender,
  };
  const token = await new SignJWT({
    environment: "production",
    owner_id: sender.ownerId,
    project_id: sender.projectId,
  })
    .setProtectedHeader({ alg: "EdDSA" })
    .setIssuer(sender.issuer)
    .setAudience(sender.audience)
    .setSubject(sender.subject)
    .setIssuedAt()
    .setExpirationTime("2m")
    .sign(signing.privateKey);
  const verifyNativeToken = vi.fn<NonNullable<NormalActorCaptureDeploymentIo["verifyNativeToken"]>>(
    async (incoming, options) => await jwtVerify(incoming, signing.publicKey, options),
  );
  const ports = createNormalActorCaptureDeploymentPorts(f.resources, { verifyNativeToken });
  const verified = await ports.verifySender(token, ports.sender);
  expect(verified.environment).toBe("production");
  expect(verifyNativeToken).toHaveBeenCalledWith(
    token,
    expect.objectContaining({ environment: "production", subject: sender.subject }),
  );
  expect(f.resources.configuration.gateway.workload).toEqual(legacySender);
});
it("uses the canonical enrolled Production sender without relabeling the Preview workload", async () => {
  const f = fixture();
  const legacySender = structuredClone(f.resources.configuration.gateway.workload);
  const sender = {
    ...legacySender,
    environment: "production" as const,
    subject: "native-production-subject",
  };
  const signing = await generateKeyPair("EdDSA");
  const key = await exportJWK(signing.publicKey);
  if (key.x === undefined) {
    throw new Error("missing public key");
  }
  f.resources.publicRealm = {
    binding: {
      enrollmentRef: "11111111-1111-4111-a111-111111111111",
      operationRef: accountOperationRef,
      planDigest: "b".repeat(64),
    },
    enrollment: {
      appId: target.appId,
      authority,
      enrollmentRef: "11111111-1111-4111-a111-111111111111",
      kind: "public-isolated-realm-v1",
      ownerSessionId: target.sessionId,
      project: { environment: "production", ownerId: sender.ownerId, projectId: sender.projectId },
      publicOrigin: program.origin,
      resource,
      sourceBootstrap: {
        authResourceId: "auth-resource",
        operationRef: accountOperationRef,
        planDigest: "b".repeat(64),
      },
      version: 1,
    },
    publicJwk: {
      alg: "EdDSA",
      crv: "Ed25519",
      kid: "public-own-app",
      kty: "OKP",
      use: "sig",
      x: key.x,
    },
    sender,
  };
  const token = await new SignJWT({
    environment: "production",
    owner_id: sender.ownerId,
    project_id: sender.projectId,
  })
    .setProtectedHeader({ alg: "EdDSA" })
    .setIssuer(sender.issuer)
    .setAudience(sender.audience)
    .setSubject(sender.subject)
    .setIssuedAt()
    .setExpirationTime("2m")
    .sign(signing.privateKey);
  const verifyNativeToken = vi.fn<NonNullable<NormalActorCaptureDeploymentIo["verifyNativeToken"]>>(
    async (incoming, options) => await jwtVerify(incoming, signing.publicKey, options),
  );
  const ports = createNormalActorCaptureDeploymentPorts(f.resources, { verifyNativeToken });
  const verified = await ports.verifySender(token, ports.sender);
  expect(verified.environment).toBe("production");
  expect(verifyNativeToken).toHaveBeenCalledWith(
    token,
    expect.objectContaining({ environment: "production", subject: sender.subject }),
  );
  expect(f.resources.configuration.gateway.workload).toEqual(legacySender);
});
