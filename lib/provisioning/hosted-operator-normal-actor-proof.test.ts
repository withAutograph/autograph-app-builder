/* oxlint-disable eslint/require-await, unicorn/no-useless-undefined -- Fixture CAS and key ports preserve their asynchronous production interfaces. */
import { createHash } from "node:crypto";
import { betterAuth } from "better-auth";
import { organization } from "better-auth/plugins";
import { generateKeyPair, SignJWT, jwtVerify } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  hostedOperatorPlanSchema,
  operatorPlanDigest,
  operatorPublicResultSchema,
} from "./hosted-operator-contract";
import {
  normalActorProgramSchema,
  normalActorProgramDigest,
} from "./hosted-operator-normal-actor-program";
import { createNormalActorJournal } from "./hosted-operator-normal-actor-journal";
import type { NormalActorJournalPorts } from "./hosted-operator-normal-actor-journal";
import { resolveFullPlan } from "./hosted-operator-composition";
import {
  assertCompletedParticipantBootstrapApproval,
  completedParticipantBootstrapSchema,
  inspectCompletedParticipantBootstrap,
} from "./hosted-operator-participant-bootstrap";
import type { CompletedParticipantBootstrap } from "./hosted-operator-participant-bootstrap";
import { hostedOperatorRealmLinkConfigSha256 } from "./hosted-operator-realm-link-config";
import {
  hostedRuntimeJournalRecordSchema,
  retainedOperatorAuthFromJournal,
} from "./hosted-runtime-journal";
import type { HostedRuntimeJournalStore, HostedRuntimeJournalRow } from "./hosted-runtime-journal";
import { prepareNormalActorAccounts } from "./hosted-operator-normal-actors";
import { createHostedOperatorNormalAuthClient } from "./hosted-operator-normal-auth-client";
import { createHostedOperatorNormalActorProofCollector } from "./hosted-operator-normal-actor-proof";
import { createProtectedHostedOperatorHandler } from "./hosted-operator-service";
import type { OperatorRequest } from "./hosted-operator-contract";
import type { ProtectedHostedOperatorDependencies } from "./hosted-operator-service";

import type { OperatorArtifactStore } from "./hosted-operator-artifact-store";

const requiredFixture = <T>(value: T | undefined): T => {
  if (value === undefined) {
    throw new Error("Missing fixture value");
  }
  return value;
};

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
  bootstrap: { endpointId: "ep_fixture", maintenanceDatabase: "neondb", role: "neondb_owner" },
  resourcesInstaller: { reference: "resources", sha256: "a".repeat(64) },
  authSchema: {
    artifactRef: "auth-plan",
    installer: { reference: "auth", sha256: "a".repeat(64) },
    planDigest: "e".repeat(64),
    targetDigest: "f".repeat(64),
  },
  gatewayBindings: {
    authBrowserOrigin: program.origin,
    builderCallbackOrigin: "https://builder.example.com",
    catalogAppIds: [target.appId],
    operatorOrigin: "https://operator.example.com",
    sourceWorkload: {
      issuer: "https://oidc.vercel.com",
      audience: "https://operator.example.com",
      ownerId: "team",
      projectId: "prj_gateway",
      environment: "preview",
      subject: "gateway",
    },
  },
  gatewayDelivery: {
    branch: target.branch,
    gitSha: "a".repeat(40),
    projectId: "prj_gateway",
    repoId: "gateway-repo",
  },
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
const fixture = async () => {
  const { privateKey, publicKey } = await generateKeyPair("EdDSA");
  const auth = betterAuth({
    secret: "normal-owner-proof-local-fixture-long-secret",
    baseURL: program.origin,
    emailAndPassword: { enabled: true },
    plugins: [organization()],
    logger: { disabled: true },
  });
  let row: HostedRuntimeJournalRow = {
    revision: 1,
    record: hostedRuntimeJournalRecordSchema.parse({
      kind: "app-runtime",
      version: 1,
      request: target,
      approvedByCallId: "initial-call",
      status: "pending",
      step: "reserved",
      operator: {
        mode: "protected-operator-v1",
        operationRef: accountOperationRef,
        plan,
        planDigest: operatorPlanDigest(plan),
        approvalId: "initial-approval",
        receipts: [],
      },
    }),
  };
  let approved = true;
  let accountApproved = true;
  let bootstrapApproved = true;
  let malformedPrivateResponse = false;
  let endpointOrigin =
    plan.deploymentBoundary?.verification.gatewayOrigin ?? "https://gateway.example.test";
  let bootstrapSnapshot: CompletedParticipantBootstrap | undefined;
  let wrongActor = false;
  let keyError: Error | undefined;
  let proofResponse: Response | undefined;
  let proofRequestError: Error | undefined;
  let proofReadbackResponse: Response | undefined;
  const requests: Request[] = [];
  const cookies = new Map<string, string>();
  const artifacts = new Map<string, string>();
  const resource = {
    version: 1 as const,
    database: plan.authDatabase.database,
    environment: "preview" as const,
    hostname: plan.neon.endpoint,
    migratorRole: plan.authDatabase.migratorRole,
    runtimeRole: plan.authDatabase.runtimeRole,
    neon: { projectId: plan.neon.projectId, branchId: plan.neon.branchId },
    port: 5432,
    schema: "public" as const,
  };
  const assertAuthorized = async () => {
    if (!approved) {
      throw new Error("fixture_approval_revoked");
    }
  };
  const journalPorts: NormalActorJournalPorts = {
    keyring: { tokenKey: Buffer.alloc(32, 7), tokenKeyVersion: "v1" },
    now: () => Date.now(),
    assertAuthorized,
    assertAccountApproval: async (_input, preparation) => {
      await assertAuthorized();
      if (!accountApproved) {
        throw new Error("fixture_account_approval_revoked");
      }
      expect(preparation.accountOperationRef).toBe(accountOperationRef);
      expect(preparation.accountApprovalId).toBe("initial-approval");
    },
    assertMutationAuthority: async (_input, current) => {
      await assertAuthorized();
      expect(current.revision).toBe(row.revision);
      expect(current.record.leaseId).toBeUndefined();
    },
    store: {
      read: async () => structuredClone(row),
      compareAndSet: async (input) => {
        if (input.expectedRevision !== row.revision) {
          return undefined;
        }
        row = {
          revision: row.revision + 1,
          record: hostedRuntimeJournalRecordSchema.parse(input.record),
        };
        return structuredClone(row);
      },
    },
  };
  const normalFetch: typeof fetch = async (url, init) => {
    const request = new Request(url, init);
    requests.push(request.clone());
    if (new URL(request.url).pathname !== "/api/auth/platform/operator-link") {
      return await auth.handler(request);
    }
    if (proofRequestError !== undefined) {
      throw proofRequestError;
    }
    if (proofResponse !== undefined) {
      return proofResponse;
    }
    expect(request.method).toBe("POST");
    expect(request.headers.get("origin")).toBe(program.origin);
    expect(request.headers.get("accept")).toBe("application/vnd.realm-operator-proof+json");
    const values = new URLSearchParams(await request.text());
    expect(values.has("operationRef")).toBe(false);
    expect(values.has("participantProgramDigest")).toBe(false);
    const actual = await auth.api.getSession({ headers: request.headers });
    if (actual === null) {
      return new Response(null, { status: 401 });
    }
    cookies.set(actual.session.id, request.headers.get("cookie") ?? "");
    const proof = await new SignJWT({
      purpose: "realm-operator-link-v1",
      sessionId: actual.session.id,
      organizationId: null,
      ownerSessionId: values.get("ownerSessionId"),
      authResourceId: values.get("authResourceId"),
      bootstrapPlanDigest: values.get("bootstrapPlanDigest"),
      nonceSha256: createHash("sha256")
        .update(values.get("nonce") ?? "")
        .digest("hex"),
      resource,
    })
      .setProtectedHeader({
        alg: "EdDSA",
        kid: "fixture-key",
        typ: "platform-realm-operator-link+jwt",
      })
      .setIssuer(program.origin)
      .setAudience("https://operator.example.com")
      .setSubject(wrongActor ? "different-real-actor" : actual.user.id)
      .setIssuedAt()
      .setExpirationTime("4m")
      .sign(privateKey);
    return Response.json(
      malformedPrivateResponse ? { version: 1, unexpected: proof } : { version: 1, proof },
      { headers: { "content-type": "application/vnd.realm-operator-proof+json" } },
    );
  };
  const journal = createNormalActorJournal(journalPorts);
  await journal.retain(context, {
    program,
    programDigest: normalActorProgramDigest(program),
    accountOperationRef,
    accountPlan: plan,
    accountPlanDigest: operatorPlanDigest(plan),
    accountApprovalId: "initial-approval",
    accountApprovedByCallId: "initial-call",
  });
  await prepareNormalActorAccounts({
    program,
    operationRef: accountOperationRef,
    ports: {
      assertCurrent: assertAuthorized,
      checkpoint: async (state) => {
        await journal.checkpoint(context, state);
      },
      readCapturedActor: async () => null,
      readOrganizationSession: async () => null,
      clientFactory: (input) =>
        createHostedOperatorNormalAuthClient({ ...input, fetch: normalFetch }),
    },
  });
  const artifactStore: OperatorArtifactStore = {
    put: async (_context, chunk) => {
      await assertAuthorized();
      const previous = artifacts.get(chunk.artifactRef);
      if (previous !== undefined && previous !== chunk.content) {
        throw new Error("fixture_immutable_artifact");
      }
      artifacts.set(chunk.artifactRef, chunk.content);
    },
    read: async (_context, ref) => {
      await assertAuthorized();
      return artifacts.get(ref);
    },
  };
  const assertPlanningAuthorized = vi.fn(async () => {
    await assertAuthorized();
  });
  const collect = createHostedOperatorNormalActorProofCollector({
    journalPorts,
    assertPlanningAuthorized,
    normalRealmFetch: async (input) => {
      expect(input.origin).toBe(program.origin);
      return normalFetch;
    },
    ownedArtifacts: async () => ({
      context: { authority, target: { appId: target.appId, sessionId: target.sessionId } },
      store: artifactStore,
    }),
    resolveRealmBinding: async () => ({
      authResourceId: plan.authDatabase.resourceId,
      bootstrapPlanDigest: operatorPlanDigest(plan),
      issuer: program.origin,
      audience: "https://operator.example.com",
      endpointOrigin,
      ...(bootstrapSnapshot === undefined
        ? {}
        : {
            bootstrap: bootstrapSnapshot,
            assertBootstrapCurrent: async () => {
              await assertAuthorized();
              await journal.read(context);
              await assertCompletedParticipantBootstrapApproval(
                context,
                requiredFixture(bootstrapSnapshot),
                async (value) => ({
                  approved: bootstrapApproved,
                  approvalId: "bootstrap-approval",
                  callId: value.callId,
                  planDigest: value.planDigest,
                  action: value.action,
                }),
              );
            },
          }),
      builderCallbackOrigin: "https://builder.example.com",
      resource,
      getKey: async () => {
        if (keyError !== undefined) {
          throw keyError;
        }
        return publicKey;
      },
      transportSource: {
        issuer: "https://oidc.vercel.com",
        audience: "https://operator.example.com",
        ownerId: "team",
        projectId: "prj_operator",
        environment: "preview",
      },
      readback: async (request) => {
        if (proofReadbackResponse !== undefined) {
          return proofReadbackResponse;
        }
        expect(new URL(request.url).origin).toBe(endpointOrigin);
        expect(new URL(request.url).pathname).toBe("/api/auth/platform/operator-identity/readback");
        const values = new URLSearchParams(await request.text());
        const proof = values.get("proof");
        if (proof === null) {
          return new Response(null, { status: 401 });
        }
        const { payload } = await jwtVerify(proof, publicKey, {
          issuer: program.origin,
          audience: "https://operator.example.com",
          ...(values.has("attestation")
            ? {
                currentDate: new Date(
                  z
                    .object({ capturedAt: z.iso.datetime() })
                    .parse(JSON.parse(values.get("attestation") ?? "{}")).capturedAt,
                ),
              }
            : {}),
        });
        const cookie = cookies.get(String(payload.sessionId));
        const actual = await auth.api.getSession({
          headers: new Headers({ cookie: cookie ?? "" }),
        });
        if (actual === null) {
          return new Response(null, { status: 401 });
        }
        return Response.json({
          identity: {
            version: 1,
            actorId: actual.user.id,
            sessionId: actual.session.id,
            organizationId: null,
            expiresAt: actual.session.expiresAt.toISOString(),
          },
          resource,
        });
      },
    }),
  });
  const input = async (organizationId: string) => {
    const prepared = await journal.read(context);
    if (prepared === undefined) {
      throw new Error("fixture_missing_preparation");
    }
    const owner = prepared.state.organizationSessions?.find(
      (entry) => entry.actorKey === "owner" && entry.organizationId === organizationId,
    )?.session;
    if (owner === undefined) {
      throw new Error("fixture_missing_owner");
    }
    return { ...context, plan, ...prepared, organizationId, owner };
  };
  const completeBootstrapRefresh = async () => {
    const store: HostedRuntimeJournalStore = {
      ...journalPorts.store,
      reserve: async () => structuredClone(row),
      reserveFenceGeneration: async () => {
        requiredFixture(row.record.operator).fenceGeneration = 1;
        row.revision += 1;
        return structuredClone(row);
      },
    };
    const refreshed = hostedOperatorPlanSchema.parse({
      ...plan,
      stage: "auth-bootstrap",
      gatewayDelivery: { ...plan.gatewayDelivery, gitSha: "b".repeat(40) },
      effects: [
        {
          id: "auth-resources",
          kind: "resources",
          resourceId: plan.authDatabase.resourceId,
          description: "Auth resource",
        },
        {
          id: "app-resources",
          kind: "resources",
          resourceId: plan.appDatabase.resourceId,
          description: "App resource",
        },
        { id: "auth-schema", kind: "install", description: "Observe Auth schema" },
        { id: "gateway-bindings", kind: "gateway-bindings", description: "Gateway binding" },
        { id: "gateway-delivery", kind: "gateway-delivery", description: "Gateway delivery" },
      ],
    });
    const deps: ProtectedHostedOperatorDependencies = {
      store,
      authorize: async () => ({
        ...context,
        ownerContext: {
          kind: "direct",
          sessionId: target.sessionId,
          adapterSessionId: "adapter",
          adapterGeneration: 1,
          authority,
          principal: { ...authority, scopes: ["autograph:send"] },
        },
      }),
      assertAuthorized,
      plan: async () => refreshed,
      readApproval: async (value) => ({
        approved: true,
        approvalId: value.callId === "initial-call" ? "initial-approval" : "bootstrap-approval",
        callId: value.callId,
        planDigest: value.planDigest,
        action: value.action,
      }),
      withResourceLease: async (_value, run) => await run(async () => {}),
      ensureNormalActorCapture: async () => "ready",
      verifyNormalActorAccounts: async () => requiredFixture(await journal.read(context)).state,
      verifyAuthReadiness: async () => ({
        assetSha256: "a".repeat(64),
        database: plan.authDatabase.database,
        runtimeRole: plan.authDatabase.runtimeRole,
        targetDigest: requiredFixture(plan.authSchema).targetDigest,
        catalogFingerprint: "c".repeat(64),
        observedAt: new Date().toISOString(),
      }),
      bindings: async () => ({}),
      verify: async () => {
        throw new Error("Full app verification is not part of bootstrap");
      },
      reconcile: async (value) => {
        if (value.effect.kind === "resources") {
          await value.checkpoint({
            encryptedToken: "ciphertext",
            keyVersion: "v1",
            tokenIv: "iv",
            tokenTag: "tag",
          });
        }
        if (value.effect.kind === "gateway-bindings") {
          await value.checkpointGatewayEnvironment?.([
            {
              id: "env",
              key: "PLATFORM_REALM_OPERATOR_LINK_CONFIG",
              branch: target.branch,
              projectId: "prj_gateway",
              operationRef: value.operationRef,
              comment: `App Builder protected operator ${value.operationRef}`,
              valueSha256: hostedOperatorRealmLinkConfigSha256(value.plan),
            },
          ]);
        }
        if (value.effect.kind === "gateway-delivery") {
          await value.checkpointGatewayDelivery?.(
            [
              {
                deploymentId: "dpl_new_gateway",
                branch: target.branch,
                projectId: "prj_gateway",
                repoId: "gateway-repo",
                operationRef: value.operationRef,
                origin: "https://new-gateway.example.test",
                readyState: "READY",
              },
            ],
            "dpl_new_gateway",
          );
        }
        return {
          status: "applied",
          receipt: {
            effectId: value.effect.id,
            observedAt: new Date().toISOString(),
            resourceVersion: "observed",
          },
        };
      },
      executeEffect: async () => {
        throw new Error("Completed effects must reconcile");
      },
    };
    const handler = createProtectedHostedOperatorHandler(deps);
    const request = async (value: OperatorRequest) => {
      const response = await handler(
        new Request("https://operator.example.com/v1/runtime", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(value),
        }),
      );
      return operatorPublicResultSchema.parse(await response.json());
    };
    expect(
      await request({
        action: "execute",
        callId: "initial-call",
        operationRef: accountOperationRef,
        planDigest: operatorPlanDigest(plan),
        selection: plan.selection,
      }),
    ).toMatchObject({ status: "participants-prepared" });
    const proposed = await request({
      action: "plan",
      operation: "prepare",
      normalActorProgram: program,
      selection: plan.selection,
    });
    expect(proposed.status).toBe("planned");
    expect(
      await request({
        action: "execute",
        callId: "bootstrap-call",
        operationRef: requiredFixture(proposed.operationRef),
        planDigest: requiredFixture(proposed.planDigest),
        selection: plan.selection,
      }),
    ).toMatchObject({ status: "auth-schema-prepared" });
    endpointOrigin = "https://new-gateway.example.test";
    const candidate = requiredFixture(
      requiredFixture(row.record.operator).gatewayDeliveryCandidates,
    )[0];
    bootstrapSnapshot = completedParticipantBootstrapSchema.parse({
      auth: retainedOperatorAuthFromJournal(row.record),
      candidate,
    });
  };
  const proposeAccess = async () => {
    if (bootstrapSnapshot === undefined) {
      throw new Error("Missing completed bootstrap");
    }
    const bootstrap = inspectCompletedParticipantBootstrap(bootstrapSnapshot.auth.plan, row.record);
    if (bootstrap === undefined) {
      throw new Error("Bootstrap is not settled");
    }
    const assertCurrent = async () => {
      await assertAuthorized();
    };
    // SAFETY: Only the selected app metadata and Gateway workload are read by this planning path; real Auth and proof ports remain above.
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- Closed synthetic configuration supplies exactly the metadata consumed by participant plan resolution.
    const configuration = {
      teamId: target.scopeId,
      applications: {
        [target.appId]: {
          accessRoles: ["owner", "member"],
          appDatabase: plan.appDatabase,
          branch: target.branch,
          projectId: target.projectId,
          repoId: "app-repo",
          gitSha: "c".repeat(40),
        },
      },
      gateway: { workload: { projectId: "prj_gateway" } },
    } as unknown as Parameters<typeof resolveFullPlan>[2];
    return await resolveFullPlan(
      bootstrap.auth.plan,
      context,
      configuration,
      {
        assertPlanningAuthorized: assertCurrent,
        readCapturedRealmIdentity: async () => null,
        readCapturedRealmIdentityProof: async () => {
          throw new Error("Participant planning cannot use legacy identity");
        },
        readNormalActorPreparation: async () => await journal.read(context),
        readNormalActorOrganizationProofs: async () => {
          const results = [];
          for (const selectedOrganization of program.organizations) {
            // oxlint-disable-next-line eslint/no-await-in-loop -- Each real proof preserves sequential journal CAS and nonce ownership.
            results.push(await collect(await input(selectedOrganization.organizationId)));
          }
          return results;
        },
      },
      {},
      true,
      false,
      undefined,
      undefined,
      { bootstrap, assertCurrent },
    );
  };
  const beginAppPlanning = async () => {
    await completeBootstrapRefresh();
    const enrolled = structuredClone(requiredFixture(row.record.accountPreparation));
    const appPlan = await proposeAccess();
    const operator = requiredFixture(row.record.operator);
    row = {
      revision: row.revision + 1,
      record: hostedRuntimeJournalRecordSchema.parse({
        ...row.record,
        approvedByCallId: "app-call",
        accountPreparation: enrolled,
        retainedAuth: requiredFixture(bootstrapSnapshot).auth,
        operator: {
          ...operator,
          approvalId: "app-approval",
          operationRef: "33333333-3333-4333-8333-333333333333",
          plan: appPlan,
          planDigest: operatorPlanDigest(appPlan),
          receipts: operator.receipts.filter((receipt) =>
            ["auth-resources", "app-resources", "auth-schema"].includes(receipt.effectId),
          ),
        },
      }),
    };
    return appPlan;
  };
  return {
    proposeAccess,
    assertPlanningAuthorized,
    completeBootstrapRefresh,
    beginAppPlanning,
    collect,
    input,
    journal,
    requests,
    artifacts,
    get row() {
      return row;
    },
    revoke() {
      approved = false;
    },
    revokeAccountApproval() {
      accountApproved = false;
    },
    revokeBootstrapApproval() {
      bootstrapApproved = false;
    },
    malformedPrivateResponse() {
      malformedPrivateResponse = true;
    },
    validPrivateResponse() {
      malformedPrivateResponse = false;
    },
    proofResponse(response: Response) {
      proofResponse = response;
    },
    proofRequestError(error: Error) {
      proofRequestError = error;
    },
    proofReadbackResponse(response: Response) {
      proofReadbackResponse = response;
    },
    keyError(error: Error) {
      keyError = error;
    },
    badActor() {
      wrongActor = true;
    },
  };
};

describe("normal organization owner proof collector", () => {
  it("preserves enrolled accounts and old proof provenance across an approved Gateway bootstrap endpoint refresh", async () => {
    const f = await fixture();
    f.malformedPrivateResponse();
    await expect(f.collect(await f.input("org-one"))).rejects.toMatchObject({
      code: "auth_identity_required",
    });
    const old = structuredClone(
      requiredFixture(requiredFixture(f.row.record.accountPreparation).organizationProofs)[0],
    );
    const sealed = structuredClone(requiredFixture(f.row.record.accountPreparation).sealedState);
    const signups = f.requests.filter(
      (request) => new URL(request.url).pathname === "/api/auth/sign-up/email",
    ).length;
    await f.completeBootstrapRefresh();
    f.validPrivateResponse();
    f.assertPlanningAuthorized.mockClear();
    const result = await f.collect(await f.input("org-one"));
    // Retain the six existing provider boundaries; private bootstrap guards use canonical ownership.
    expect(f.assertPlanningAuthorized).toHaveBeenCalledTimes(6);
    expect(result.identityVerification.jwksUrl).toBe(
      "https://new-gateway.example.test/_platform/jwks.json",
    );
    expect(result.bootstrapPlanDigest).toBe(operatorPlanDigest(plan));
    expect(result.identityNonceSha256).not.toBe(old.link.nonceSha256);
    const proposed = await f.proposeAccess();
    expect(proposed.stage).toBe("app");
    expect(proposed.normalActorPreparation?.accountOperationRef).toBe(accountOperationRef);
    expect(proposed.gatewayDelivery?.gitSha).toBe("b".repeat(40));
    expect(proposed.authMembership?.kind).toBe("create-owned-organizations");
    expect(requiredFixture(f.row.record.accountPreparation).sealedState).toEqual(sealed);
    expect(f.row.record.accountPreparation).toMatchObject({ supersededOrganizationProofs: [old] });
    expect(
      f.requests.filter((request) => new URL(request.url).pathname === "/api/auth/sign-up/email"),
    ).toHaveLength(signups);
  });
  it("plans through the real collector and journal from incomplete app receipts and retained Auth/accounts", async () => {
    const f = await fixture();
    await f.beginAppPlanning();
    const before = structuredClone(f.row.record);
    const revision = f.row.revision;
    expect(before.accountPreparation?.organizationProofs).toBeUndefined();
    const signups = f.requests.filter(
      (request) => new URL(request.url).pathname === "/api/auth/sign-up/email",
    ).length;
    expect(before.operator?.receipts.map((receipt) => receipt.effectId)).toEqual([
      "auth-resources",
      "app-resources",
      "auth-schema",
    ]);
    const proposed = await f.proposeAccess();
    expect(proposed.stage).toBe("app");
    expect(proposed.normalActorPreparation?.accountOperationRef).toBe(accountOperationRef);
    expect(proposed.authMembership?.kind).toBe("create-owned-organizations");
    expect(f.row.revision).toBeGreaterThan(revision);
    expect(
      f.row.record.accountPreparation?.organizationProofs?.every(
        (proof) => proof.link.consumedAt !== undefined,
      ),
    ).toBe(true);
    expect(f.row.record.accountPreparation?.sealedState).toEqual(
      before.accountPreparation?.sealedState,
    );
    expect(f.row.record.operator).toEqual(before.operator);
    expect(f.row.record.retainedAuth).toEqual(before.retainedAuth);
    expect(
      f.requests.filter((request) => new URL(request.url).pathname === "/api/auth/sign-up/email"),
    ).toHaveLength(signups);
  });

  it.each(["original-auth", "original-account", "current-owner"])(
    "rejects revoked %s authority while replanning an incomplete app",
    async (change) => {
      const f = await fixture();
      await f.beginAppPlanning();
      if (change === "original-auth") {
        f.revokeBootstrapApproval();
      } else if (change === "original-account") {
        f.revokeAccountApproval();
      } else {
        f.revoke();
      }
      const before = structuredClone(f.row);
      const artifacts = [...f.artifacts];
      await expect(f.proposeAccess()).rejects.toThrow();
      expect(f.row).toEqual(before);
      expect([...f.artifacts]).toEqual(artifacts);
    },
  );
  afterEach(() => vi.restoreAllMocks());
  it.each([
    { status: 401, contentType: "text/html", valid: false },
    { status: 503, contentType: "application/vnd.realm-operator-proof+json", valid: true },
  ])(
    "reports only closed proof response facts for $status",
    async ({ status, contentType, valid }) => {
      const log = vi.spyOn(console, "info").mockImplementation(() => {});
      const f = await fixture();
      f.proofResponse(
        new Response("private cookie JWT URL actor", {
          status,
          headers: { "content-type": contentType },
        }),
      );
      await expect(f.collect(await f.input("org-one"))).rejects.toMatchObject({
        code: "auth_identity_required",
      });
      expect(log).toHaveBeenCalledWith(
        "[builder:hosted-neon-consent]",
        expect.objectContaining({
          normalActorProofFailure: {
            stage: "proof_response",
            cookiePresent: true,
            httpStatus: status,
            contentTypeValid: valid,
            redirected: false,
            errorClass: "operator_error",
            code: "auth_identity_required",
          },
        }),
      );
      expect(JSON.stringify(log.mock.calls)).not.toContain("private cookie JWT URL actor");
      expect(
        f.row.record.accountPreparation?.organizationProofs?.[0]?.link.consumedAt,
      ).toBeUndefined();
      expect(f.artifacts.size).toBe(0);
    },
  );
  it("distinguishes request transport exceptions without logging their message", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const f = await fixture();
    f.proofRequestError(new TypeError("https://private.example/?cookie=secret"));
    await expect(f.collect(await f.input("org-one"))).rejects.toMatchObject({
      code: "auth_identity_required",
    });
    expect(log).toHaveBeenCalledWith(
      "[builder:hosted-neon-consent]",
      expect.objectContaining({
        normalActorProofFailure: {
          stage: "proof_request",
          cookiePresent: true,
          errorClass: "type_error",
        },
      }),
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain("private.example");
  });
  it("distinguishes native readback rejection after a valid proof", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const f = await fixture();
    f.proofReadbackResponse(new Response(null, { status: 403 }));
    await expect(f.collect(await f.input("org-one"))).rejects.toMatchObject({
      code: "auth_identity_required",
    });
    expect(log).toHaveBeenCalledWith(
      "[builder:hosted-neon-consent]",
      expect.objectContaining({
        normalActorProofFailure: {
          stage: "proof_readback_response",
          httpStatus: 403,
          redirected: false,
          errorClass: "operator_error",
          code: "auth_identity_required",
        },
      }),
    );
    expect(f.artifacts.size).toBe(0);
  });
  it("distinguishes proof key verification failure before readback", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const f = await fixture();
    f.keyError(new Error("private key endpoint message"));
    await expect(f.collect(await f.input("org-one"))).rejects.toMatchObject({
      code: "auth_identity_required",
    });
    expect(log.mock.calls[0]?.[1]).toHaveProperty("normalActorProofFailure.stage", "proof_verify");
    expect(JSON.stringify(log.mock.calls)).not.toContain("private key endpoint message");
    expect(f.artifacts.size).toBe(0);
  });
  it("preserves the rejection when logging throws", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {
      throw new Error("logger failure");
    });
    const f = await fixture();
    f.malformedPrivateResponse();
    await expect(f.collect(await f.input("org-one"))).rejects.toMatchObject({
      code: "auth_identity_required",
    });
  });
  it("collects signed actual per-organization session proofs and reuses the same private artifacts on retry", async () => {
    const f = await fixture();
    const one = await f.collect(await f.input("org-one"));
    const two = await f.collect(await f.input("org-two"));
    expect(one.identityCapture.realmSessionId).not.toBe(two.identityCapture.realmSessionId);
    expect(one.identityProof.reference).not.toBe(two.identityProof.reference);
    expect(f.row.record.accountPreparation?.organizationProofs).toHaveLength(2);
    const retained = f.row.record.accountPreparation?.organizationProofs?.[0];
    expect(retained?.link.sealedNonce).toBeDefined();
    expect(retained?.link.organizationId).toBeNull();
    expect(retained?.owner.realmSessionId).toBe(one.identityCapture.realmSessionId);
    expect(await f.collect(await f.input("org-one"))).toEqual(one);
    expect(
      f.requests.filter(
        (request) => new URL(request.url).pathname === "/api/auth/platform/operator-link",
      ),
    ).toHaveLength(2);
    expect(f.requests.every((request) => new URL(request.url).origin === program.origin)).toBe(
      true,
    );
    expect(f.artifacts.size).toBe(2);
  });
  it("rejects malformed private proof responses without retaining a proof", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const f = await fixture();
    f.malformedPrivateResponse();
    await expect(f.collect(await f.input("org-one"))).rejects.toMatchObject({
      code: "auth_identity_required",
    });
    expect(log.mock.calls[0]?.[1]).toHaveProperty("normalActorProofFailure.stage", "proof_decode");
    expect(f.artifacts.size).toBe(0);
    expect(
      f.row.record.accountPreparation?.organizationProofs?.[0]?.link.consumedAt,
    ).toBeUndefined();
  });
  it("rejects a signed claim that differs from the actual retained owner session", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const f = await fixture();
    f.badActor();
    await expect(f.collect(await f.input("org-one"))).rejects.toMatchObject({
      code: "auth_identity_required",
    });
    expect(log.mock.calls[0]?.[1]).toHaveProperty(
      "normalActorProofFailure.stage",
      "proof_readback_response",
    );
    expect(log.mock.calls[0]?.[1]).toHaveProperty("normalActorProofFailure.httpStatus", 200);
    expect(f.artifacts.size).toBe(0);
  });
  it("rechecks first account authority on a consumed retry before any new request", async () => {
    const f = await fixture();
    const input = await f.input("org-one");
    await f.collect(input);
    const before = f.requests.length;
    f.revoke();
    await expect(f.collect(input)).rejects.toMatchObject({ code: "auth_identity_required" });
    expect(f.requests).toHaveLength(before);
  });
});
