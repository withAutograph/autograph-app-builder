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
  audience: "https://builder.example.test/mcp",
  issuer: "https://builder.example.test/api/auth",
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
const context = { authority, target };
const program = normalActorProgramSchema.parse({
  actors: [
    {
      account: "create-email-password",
      actorKey: "owner",
      email: "owner@example.com",
      name: "Owner",
    },
    { account: "create-email-password", actorKey: "peer", email: "peer@example.com", name: "Peer" },
  ],
  appAccess: [
    { actorKey: "owner", organizationId: "org-one", roles: ["owner"] },
    { actorKey: "peer", organizationId: "org-two", roles: ["member"] },
  ],
  appId: target.appId,
  memberships: [
    { actorKey: "owner", organizationId: "org-one", role: "owner" },
    { actorKey: "peer", organizationId: "org-one", role: "member" },
    { actorKey: "owner", organizationId: "org-two", role: "owner" },
    { actorKey: "peer", organizationId: "org-two", role: "member" },
  ],
  organizations: [
    { name: "One", organizationId: "org-one", ownerActorKey: "owner", slug: "one" },
    { name: "Two", organizationId: "org-two", ownerActorKey: "owner", slug: "two" },
  ],
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
  authSchema: {
    artifactRef: "auth-plan",
    installer: { reference: "auth", sha256: "a".repeat(64) },
    planDigest: "e".repeat(64),
    targetDigest: "f".repeat(64),
  },
  bootstrap: { endpointId: "ep_fixture", maintenanceDatabase: "neondb", role: "neondb_owner" },
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
      gatewayOrigin: "https://gateway.example.test",
      jwksUrl: "https://gateway.example.test/_platform/jwks.json",
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
  gatewayBindings: {
    authBrowserOrigin: program.origin,
    builderCallbackOrigin: "https://builder.example.com",
    catalogAppIds: [target.appId],
    operatorOrigin: "https://operator.example.com",
    sourceWorkload: {
      audience: "https://operator.example.com",
      environment: "preview",
      issuer: "https://oidc.vercel.com",
      ownerId: "team",
      projectId: "prj_gateway",
      subject: "gateway",
    },
  },
  gatewayDelivery: {
    branch: target.branch,
    gitSha: "a".repeat(40),
    projectId: "prj_gateway",
    repoId: "gateway-repo",
  },
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
  resourcesInstaller: { reference: "resources", sha256: "a".repeat(64) },
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
const fixture = async (publicRelease?: {
  enrollmentRef: string;
  operationRef: string;
  planDigest: string;
}) => {
  const { privateKey, publicKey } = await generateKeyPair("EdDSA");
  const auth = betterAuth({
    baseURL: program.origin,
    emailAndPassword: { enabled: true },
    logger: { disabled: true },
    plugins: [organization()],
    secret: "normal-owner-proof-local-fixture-long-secret",
  });
  let row: HostedRuntimeJournalRow = {
    record: hostedRuntimeJournalRecordSchema.parse({
      approvedByCallId: "initial-call",
      kind: "app-runtime",
      operator: {
        approvalId: "initial-approval",
        mode: "protected-operator-v1",
        operationRef: accountOperationRef,
        plan,
        planDigest: operatorPlanDigest(plan),
        receipts: [],
      },
      request: target,
      status: "pending",
      step: "reserved",
      version: 1,
    }),
    revision: 1,
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
    database: plan.authDatabase.database,
    environment: "preview" as const,
    hostname: plan.neon.endpoint,
    migratorRole: plan.authDatabase.migratorRole,
    neon: { branchId: plan.neon.branchId, projectId: plan.neon.projectId },
    port: 5432,
    runtimeRole: plan.authDatabase.runtimeRole,
    schema: "public" as const,
    version: 1 as const,
  };
  const assertAuthorized = async () => {
    if (!approved) {
      throw new Error("fixture_approval_revoked");
    }
  };
  const journalPorts: NormalActorJournalPorts = {
    assertAccountApproval: async (_input, preparation) => {
      await assertAuthorized();
      if (!accountApproved) {
        throw new Error("fixture_account_approval_revoked");
      }
      expect(preparation.accountOperationRef).toBe(accountOperationRef);
      expect(preparation.accountApprovalId).toBe("initial-approval");
    },
    assertAuthorized,
    assertMutationAuthority: async (_input, current) => {
      await assertAuthorized();
      expect(current.revision).toBe(row.revision);
      expect(current.record.leaseId).toBeUndefined();
    },
    keyring: { tokenKey: Buffer.alloc(32, 7), tokenKeyVersion: "v1" },
    now: () => Date.now(),
    store: {
      compareAndSet: async (input) => {
        if (input.expectedRevision !== row.revision) {
          return undefined;
        }
        row = {
          record: hostedRuntimeJournalRecordSchema.parse(input.record),
          revision: row.revision + 1,
        };
        return structuredClone(row);
      },
      read: async () => structuredClone(row),
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
      authResourceId: values.get("authResourceId"),
      bootstrapPlanDigest: values.get("bootstrapPlanDigest"),
      nonceSha256: createHash("sha256")
        .update(values.get("nonce") ?? "")
        .digest("hex"),
      organizationId: null,
      ownerSessionId: values.get("ownerSessionId"),
      purpose: "realm-operator-link-v1",
      resource,
      sessionId: actual.session.id,
      ...(values.has("publicEnrollmentRef")
        ? {
            publicRelease: {
              enrollmentRef: values.get("publicEnrollmentRef"),
              operationRef: values.get("publicOperationRef"),
              planDigest: values.get("publicPlanDigest"),
            },
          }
        : {}),
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
      malformedPrivateResponse ? { unexpected: proof, version: 1 } : { proof, version: 1 },
      { headers: { "content-type": "application/vnd.realm-operator-proof+json" } },
    );
  };
  const journal = createNormalActorJournal(journalPorts);
  await journal.retain(context, {
    accountApprovalId: "initial-approval",
    accountApprovedByCallId: "initial-call",
    accountOperationRef,
    accountPlan: plan,
    accountPlanDigest: operatorPlanDigest(plan),
    program,
    programDigest: normalActorProgramDigest(program),
  });
  await prepareNormalActorAccounts({
    operationRef: accountOperationRef,
    ports: {
      assertCurrent: assertAuthorized,
      checkpoint: async (state) => {
        await journal.checkpoint(context, state);
      },
      clientFactory: (input) =>
        createHostedOperatorNormalAuthClient({ ...input, fetch: normalFetch }),
      readCapturedActor: async () => null,
      readOrganizationSession: async () => null,
    },
    program,
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
    assertPlanningAuthorized,
    journalPorts,
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
      ...(publicRelease === undefined ? {} : { publicRelease }),

      issuer: program.origin,
      audience: "https://operator.example.com",
      endpointOrigin,
      ...(bootstrapSnapshot === undefined
        ? {}
        : {
            assertBootstrapCurrent: async () => {
              await assertAuthorized();
              await journal.read(context);
              await assertCompletedParticipantBootstrapApproval(
                context,
                requiredFixture(bootstrapSnapshot),
                async (value) => ({
                  action: value.action,
                  approvalId: "bootstrap-approval",
                  approved: bootstrapApproved,
                  callId: value.callId,
                  planDigest: value.planDigest,
                }),
              );
            },
            bootstrap: bootstrapSnapshot,
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
        audience: "https://operator.example.com",
        environment: "preview",
        issuer: "https://oidc.vercel.com",
        ownerId: "team",
        projectId: "prj_operator",
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
          audience: "https://operator.example.com",
          issuer: program.origin,
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
            actorId: actual.user.id,
            expiresAt: actual.session.expiresAt.toISOString(),
            organizationId: null,
            sessionId: actual.session.id,
            version: 1,
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
      effects: [
        {
          description: "Auth resource",
          id: "auth-resources",
          kind: "resources",
          resourceId: plan.authDatabase.resourceId,
        },
        {
          description: "App resource",
          id: "app-resources",
          kind: "resources",
          resourceId: plan.appDatabase.resourceId,
        },
        { description: "Observe Auth schema", id: "auth-schema", kind: "install" },
        { description: "Gateway binding", id: "gateway-bindings", kind: "gateway-bindings" },
        { description: "Gateway delivery", id: "gateway-delivery", kind: "gateway-delivery" },
      ],
      gatewayDelivery: { ...plan.gatewayDelivery, gitSha: "b".repeat(40) },
      stage: "auth-bootstrap",
    });
    const deps: ProtectedHostedOperatorDependencies = {
      assertAuthorized,
      authorize: async () => ({
        ...context,
        ownerContext: {
          adapterGeneration: 1,
          adapterSessionId: "adapter",
          authority,
          kind: "direct",
          principal: { ...authority, scopes: ["autograph:send"] },
          sessionId: target.sessionId,
        },
      }),
      bindings: async () => ({}),
      ensureNormalActorCapture: async () => "ready",
      executeEffect: async () => {
        throw new Error("Completed effects must reconcile");
      },
      plan: async () => refreshed,
      readApproval: async (value) => ({
        action: value.action,
        approvalId: value.callId === "initial-call" ? "initial-approval" : "bootstrap-approval",
        approved: true,
        callId: value.callId,
        planDigest: value.planDigest,
      }),
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
              branch: target.branch,
              comment: `App Builder protected operator ${value.operationRef}`,
              id: "env",
              key: "PLATFORM_REALM_OPERATOR_LINK_CONFIG",
              operationRef: value.operationRef,
              projectId: "prj_gateway",
              valueSha256: hostedOperatorRealmLinkConfigSha256(value.plan),
            },
          ]);
        }
        if (value.effect.kind === "gateway-delivery") {
          await value.checkpointGatewayDelivery?.(
            [
              {
                branch: target.branch,
                deploymentId: "dpl_new_gateway",
                operationRef: value.operationRef,
                origin: "https://new-gateway.example.test",
                projectId: "prj_gateway",
                readyState: "READY",
                repoId: "gateway-repo",
              },
            ],
            "dpl_new_gateway",
          );
        }
        return {
          receipt: {
            effectId: value.effect.id,
            observedAt: new Date().toISOString(),
            resourceVersion: "observed",
          },
          status: "applied",
        };
      },
      store,
      verify: async () => {
        throw new Error("Full app verification is not part of bootstrap");
      },
      verifyAuthReadiness: async () => ({
        assetSha256: "a".repeat(64),
        catalogFingerprint: "c".repeat(64),
        database: plan.authDatabase.database,
        observedAt: new Date().toISOString(),
        runtimeRole: plan.authDatabase.runtimeRole,
        targetDigest: requiredFixture(plan.authSchema).targetDigest,
      }),
      verifyNormalActorAccounts: async () => requiredFixture(await journal.read(context)).state,
      withResourceLease: async (_value, run) => await run(async () => {}),
    };
    const handler = createProtectedHostedOperatorHandler(deps);
    const request = async (value: OperatorRequest) => {
      const response = await handler(
        new Request("https://operator.example.com/v1/runtime", {
          body: JSON.stringify(value),
          headers: { "content-type": "application/json" },
          method: "POST",
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
      normalActorProgram: program,
      operation: "prepare",
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
      applications: {
        [target.appId]: {
          accessRoles: ["owner", "member"],
          appDatabase: plan.appDatabase,
          branch: target.branch,
          gitSha: "c".repeat(40),
          projectId: target.projectId,
          repoId: "app-repo",
        },
      },
      gateway: { workload: { projectId: "prj_gateway" } },
      teamId: target.scopeId,
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
        readNormalActorOrganizationProofs: async () => {
          const results = [];
          for (const selectedOrganization of program.organizations) {
            // oxlint-disable-next-line eslint/no-await-in-loop -- Each real proof preserves sequential journal CAS and nonce ownership.
            results.push(await collect(await input(selectedOrganization.organizationId)));
          }
          return results;
        },
        readNormalActorPreparation: async () => await journal.read(context),
      },
      {},
      true,
      false,
      undefined,
      undefined,
      { assertCurrent, bootstrap },
    );
  };
  const beginAppPlanning = async () => {
    await completeBootstrapRefresh();
    const enrolled = structuredClone(requiredFixture(row.record.accountPreparation));
    const appPlan = await proposeAccess();
    const operator = requiredFixture(row.record.operator);
    row = {
      record: hostedRuntimeJournalRecordSchema.parse({
        ...row.record,
        accountPreparation: enrolled,
        approvedByCallId: "app-call",
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
        retainedAuth: requiredFixture(bootstrapSnapshot).auth,
      }),
      revision: row.revision + 1,
    };
    return appPlan;
  };
  return {
    artifacts,
    assertPlanningAuthorized,
    badActor() {
      wrongActor = true;
    },
    beginAppPlanning,
    collect,
    completeBootstrapRefresh,
    input,
    journal,
    keyError(error: Error) {
      keyError = error;
    },
    malformedPrivateResponse() {
      malformedPrivateResponse = true;
    },
    proofReadbackResponse(response: Response) {
      proofReadbackResponse = response;
    },
    proofRequestError(error: Error) {
      proofRequestError = error;
    },
    proofResponse(response: Response) {
      proofResponse = response;
    },
    proposeAccess,
    requests,
    revoke() {
      approved = false;
    },
    revokeAccountApproval() {
      accountApproved = false;
    },
    revokeBootstrapApproval() {
      bootstrapApproved = false;
    },
    get row() {
      return row;
    },
    validPrivateResponse() {
      malformedPrivateResponse = false;
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
    const { revision } = f.row;
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
    { contentType: "text/html", status: 401, valid: false },
    { contentType: "application/vnd.realm-operator-proof+json", status: 503, valid: true },
  ])(
    "reports only closed proof response facts for $status",
    async ({ status, contentType, valid }) => {
      const log = vi.spyOn(console, "info").mockImplementation(() => {});
      const f = await fixture();
      f.proofResponse(
        new Response("private cookie JWT URL actor", {
          headers: { "content-type": contentType },
          status,
        }),
      );
      await expect(f.collect(await f.input("org-one"))).rejects.toMatchObject({
        code: "auth_identity_required",
      });
      expect(log).toHaveBeenCalledWith(
        "[builder:hosted-neon-consent]",
        expect.objectContaining({
          normalActorProofFailure: {
            code: "auth_identity_required",
            contentTypeValid: valid,
            cookiePresent: true,
            errorClass: "operator_error",
            httpStatus: status,
            redirected: false,
            stage: "proof_response",
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
          cookiePresent: true,
          errorClass: "type_error",
          stage: "proof_request",
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
          code: "auth_identity_required",
          errorClass: "operator_error",
          httpStatus: 403,
          redirected: false,
          stage: "proof_readback_response",
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

it("carries the exact public release through durable organization nonce, Auth request and signed proof", async () => {
  const publicRelease = {
    enrollmentRef: "88888888-8888-4888-a888-888888888888",
    operationRef: "99999999-9999-4999-a999-999999999999",
    planDigest: "d".repeat(64),
  };
  const f = await fixture(publicRelease);
  await f.collect(await f.input("org-one"));
  const retained = f.row.record.accountPreparation?.organizationProofs?.[0];
  expect(retained?.link.publicRelease).toEqual(publicRelease);
  expect(retained?.link.consumedAt).toBeDefined();
  const request = f.requests.find(
    (entry) => new URL(entry.url).pathname === "/api/auth/platform/operator-link",
  );
  expect(request).toBeDefined();
  const body = new URLSearchParams(await requiredFixture(request).text());
  expect(body.get("publicEnrollmentRef")).toBe(publicRelease.enrollmentRef);
  expect(body.get("publicOperationRef")).toBe(publicRelease.operationRef);
  expect(body.get("publicPlanDigest")).toBe(publicRelease.planDigest);
});

it("carries the exact public release through durable organization nonce, Auth request and signed proof", async () => {
  const publicRelease = {
    enrollmentRef: "88888888-8888-4888-a888-888888888888",
    operationRef: "99999999-9999-4999-a999-999999999999",
    planDigest: "d".repeat(64),
  };
  const f = await fixture(publicRelease);
  await f.collect(await f.input("org-one"));
  const retained = f.row.record.accountPreparation?.organizationProofs?.[0];
  expect(retained?.link.publicRelease).toEqual(publicRelease);
  expect(retained?.link.consumedAt).toBeDefined();
  const request = f.requests.find(
    (entry) => new URL(entry.url).pathname === "/api/auth/platform/operator-link",
  );
  expect(request).toBeDefined();
  const body = new URLSearchParams(await requiredFixture(request).text());
  expect(body.get("publicEnrollmentRef")).toBe(publicRelease.enrollmentRef);
  expect(body.get("publicOperationRef")).toBe(publicRelease.operationRef);
  expect(body.get("publicPlanDigest")).toBe(publicRelease.planDigest);
});
