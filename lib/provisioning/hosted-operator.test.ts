import { createHash, generateKeyPairSync } from "node:crypto";
import { observeOperatorExecutionStage } from "./hosted-operator-consent-diagnostic";
import type { HostedOperatorConsentDiagnosticSink } from "./hosted-operator-consent-diagnostic";
import {
  OPERATOR_EXECUTION_OBSERVATION_HEADER,
  OPERATOR_EXECUTION_OBSERVATION_PREFERENCE,
} from "./hosted-operator-execution-observation-protocol";
import {
  composeHostedOperatorAuthorizationDependencies,
  composeHostedOperatorDependencies,
} from "./hosted-operator-composition";
// oxlint-disable-next-line sonarjs/no-wildcard-import -- Inject only the SQL snapshot transport while retaining the actual readiness producer and all its checks.
import * as appReadiness from "./hosted-operator-app-readiness";
import type { AppRuntimeSnapshotReader } from "./hosted-operator-app-readiness";
import { readHostedOperatorSourceConfiguration } from "./hosted-operator-source-configuration";
/* oxlint-disable eslint/require-await, eslint/no-await-in-loop, sonarjs/no-hardcoded-passwords, unicorn/no-await-expression-member -- Synthetic service adapters and credentials only; plan replacements run sequentially against one journal. */
import { once } from "node:events";
import { text } from "node:stream/consumers";
import { z } from "zod";
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createHostedOperatorClient,
  hostedOperatorClientForSession,
} from "./hosted-operator-client";
import { createProtectedHostedOperatorHandler } from "./hosted-operator-service";
import type { ProtectedHostedOperatorDependencies } from "./hosted-operator-service";
import {
  HostedOperatorError,
  hostedOperatorRecordSchema,
  hostedOperatorPlanSchema,
  operatorPlanDigest,
  operatorPublicResultSchema,
  restrictedOperatorEnvironment,
} from "./hosted-operator-contract";
import type { ManagedOperatorEnvironmentRow, OperatorSelection } from "./hosted-operator-contract";
import {
  hostedRuntimeIdentity,
  hostedRuntimeProofSchema,
  hostedRuntimeJournalRecordSchema,
  retainedOperatorAuthFromJournal,
} from "./hosted-runtime-journal";
import type { HostedRuntimeJournalRow, HostedRuntimeJournalStore } from "./hosted-runtime-journal";
import { publicApprovalDescription } from "../agent/approval-receipt";
import { createInstallerSourceSuccessorPlan } from "./hosted-operator-installer-source-successor";
import { normalActorProgramDigest } from "./hosted-operator-normal-actor-program";

const authority = {
  audience: "https://builder.example/mcp",
  issuer: "https://builder.example/api/auth",
  ownerUserId: "owner",
  workspaceId: "workspace",
};
const selection: OperatorSelection = {
  appId: "spend-review",
  branch: "preview",
  environment: "preview",
  projectId: "prj_fixture",
  sessionId: "session_fixture",
};
const ownerContext = {
  adapterGeneration: 1,
  adapterSessionId: "adapter-session",
  authority,
  kind: "direct" as const,
  principal: { ...authority, scopes: ["autograph:send"] },
  sessionId: selection.sessionId,
};
const target = {
  ...selection,
  installationId: "icfg_fixture",
  scopeId: "team_fixture",
  scopeType: "team" as const,
};
const plan = hostedOperatorPlanSchema.parse({
  access: [{ actorId: "synthetic-reviewer", organizationId: "synthetic-org", roles: ["reviewer"] }],
  action: "prepare",
  appDatabase: {
    database: "spend",
    migratorRole: "spend_owner",
    resourceId: "app-resource",
    runtimeRole: "spend_runtime",
  },
  authDatabase: {
    database: "shared_auth",
    migratorRole: "shared_auth_owner",
    resourceId: "auth-resource",
    runtimeRole: "shared_auth_runtime",
  },
  contextId: "synthetic-context",
  cost: {
    class: "shared-recovery-group",
    description: "Approved disposable compute",
    owner: "Fixture owner",
  },
  deploymentBoundary: {
    app: {
      branch: selection.branch,
      deploymentId: "dpl_app",
      environment: "preview",
      projectId: selection.projectId,
    },
    authority,
    gateway: {
      branch: selection.branch,
      deploymentId: "dpl_gateway",
      environment: "preview",
      projectId: "prj_gateway",
    },
    operator: {
      deploymentId: "dpl_operator",
      environment: "production",
      projectId: "prj_operator",
    },
    teamId: "team_fixture",
    verification: {
      gatewayOrigin: "https://gateway-preview.example.test",
      jwksUrl: "https://gateway-preview.example.test/_platform/jwks.json",
      publicOrigin: "https://apps-preview.example.test",
    },
  },
  effects: [
    {
      description: "Verify selected resources and their roles",
      id: "resources",
      kind: "resources",
    },

    { description: "Install the selected checked release", id: "install", kind: "install" },
    { description: "Grant approved Auth app access after install", id: "access", kind: "access" },
    {
      description: "Bind restricted app and shared Auth credentials",
      id: "bind",
      kind: "bindings",
    },
  ],
  installer: { reference: "trusted-toolchain", sha256: "a".repeat(64) },
  neon: {
    branchId: "br_synthetic",
    connectionRef: "explicit-owner-connection",
    endpoint: "ep-fixture.us-east-1.aws.neon.tech",
    projectId: "synthetic-project",
    source: "synthetic-only",
  },
  publicGateway: {
    branch: selection.branch,
    origin: "https://apps-preview.example.test",
    projectId: "prj_gateway",
  },
  release: { artifactRef: "verified-artifact", id: "release_fixture", sha256: "b".repeat(64) },
  retention: {
    expiresAt: "2027-01-01T00:00:00.000Z",
    policy: "Retain while context consumers exist",
  },
  selection,
  version: 1,
});
const proof = {
  actors: 2,
  artifactHash: "c".repeat(64),
  authenticatedBehavior: "unassessed" as const,
  manifestSha256: plan.release.sha256,
  releaseId: plan.release.id,
  tenants: 2,
};
const appBoundary = {
  appId: selection.appId,
  mode: "protected-gateway-v1",
  runtime: {
    database: plan.appDatabase.database,
    environment: "hosted",
    hostname: plan.neon.endpoint,
    port: 5432,
    runtimeRole: plan.appDatabase.runtimeRole,
  },
  verification: {
    jwksUrl: plan.deploymentBoundary?.verification.jwksUrl,
    publicOrigin: plan.deploymentBoundary?.verification.publicOrigin,
  },
  version: 1,
};
const environment = {
  PLATFORM_APP_BOUNDARY: JSON.stringify(appBoundary),
  PLATFORM_JWKS_URL: "https://gateway-preview.example.test/_platform/jwks.json",
  PLATFORM_ORIGIN: "https://gateway-preview.example.test",
  PLATFORM_PUBLIC_ORIGIN: "https://apps-preview.example.test",
  SPEND_REVIEW_DATABASE_URL: `postgres://spend_runtime:synthetic-app@${plan.neon.endpoint}/spend?sslmode=verify-full`,
};

const fixture = (clock?: () => number) => {
  let row: HostedRuntimeJournalRow | undefined;
  let member = true;
  let approved = false;
  let uncertain = false;
  let fence = true;
  let nextFenceGeneration = 0;
  const applied = new Map<
    string,
    { effectId: string; fenceGeneration: number; observedAt: string; resourceVersion: string }
  >();
  const store: HostedRuntimeJournalStore = {
    async compareAndSet(input) {
      if (row?.revision !== input.expectedRevision) {
        // oxlint-disable-next-line unicorn/no-useless-undefined -- CAS failure is the explicit optional-row return contract.
        return undefined;
      }
      row = {
        record: hostedRuntimeJournalRecordSchema.parse(input.record),
        revision: input.expectedRevision + 1,
      };
      return structuredClone(row);
    },
    async read() {
      return row ? structuredClone(row) : undefined;
    },
    async reserve(input) {
      row ??= {
        record: hostedRuntimeJournalRecordSchema.parse({
          approvedByCallId: input.approvedByCallId,
          kind: "app-runtime",
          operator: input.operator,
          request: input.target,
          status: "pending",
          step: "reserved",
          version: 1,
        }),
        revision: 1,
      };
      return structuredClone(row);
    },
    async reserveFenceGeneration(input) {
      if (row === undefined) {
        // oxlint-disable-next-line unicorn/no-useless-undefined -- The journal CAS reports no allocated row.
        return undefined;
      }
      if (
        row.revision !== input.expectedRevision ||
        row.record.leaseId !== input.leaseId ||
        row.record.operator?.operationRef !== input.operationRef ||
        row.record.operator.fenceGeneration !== undefined
      ) {
        // oxlint-disable-next-line unicorn/no-useless-undefined -- A stale CAS must not allocate a generation.
        return undefined;
      }
      nextFenceGeneration += 1;
      const generation = nextFenceGeneration;
      row = {
        record: hostedRuntimeJournalRecordSchema.parse({
          ...row.record,
          operator: { ...row.record.operator, fenceGeneration: generation },
        }),
        revision: row.revision + 1,
      };
      return structuredClone(row);
    },
  };
  const deps: ProtectedHostedOperatorDependencies = {
    ...(clock === undefined ? {} : { now: clock }),
    async assertAuthorized() {
      if (!member) {
        throw new HostedOperatorError("authorization_required");
      }
    },
    async authorize(request, selected) {
      if (
        request.headers.get("authorization") !== "Bearer fixture-service-identity" ||
        request.headers.get("x-vercel-trusted-oidc-idp-token") !== "fixture-service-identity" ||
        selected.sessionId !== selection.sessionId
      ) {
        throw new HostedOperatorError("authorization_required");
      }
      return { authority, target };
    },
    async bindings() {
      return environment;
    },
    executeEffect: vi.fn<ProtectedHostedOperatorDependencies["executeEffect"]>(async (input) => {
      await input.assertCurrent();
      await input.checkpoint({
        encryptedToken: "ciphertext",
        keyVersion: "key-v1",
        tokenIv: "iv",
        tokenTag: "tag",
      });
      const receipt = {
        effectId: input.effect.id,
        fenceGeneration: input.fenceGeneration,
        observedAt: new Date().toISOString(),
        resourceVersion: "provider-observed-v1",
      };
      applied.set(input.effect.id, receipt);
      return receipt;
    }),
    plan: vi.fn(async () => plan),
    async readApproval(input) {
      return approved
        ? {
            action: input.action,
            approvalId: "durable-human-decision",
            approved: true,
            callId: input.callId,
            planDigest: input.planDigest,
          }
        : null;
    },
    async reconcile(input) {
      if (uncertain) {
        return { status: "unknown" };
      }
      const receipt = applied.get(input.effect.id);
      return receipt ? { receipt, status: "applied" } : { status: "absent" };
    },
    store,
    async verify() {
      return proof;
    },
    async withResourceLease(_input, run) {
      return await run(async () => {
        if (!fence) {
          throw new HostedOperatorError("operation_in_progress");
        }
      });
    },
  };
  const handler = createProtectedHostedOperatorHandler(deps);
  const client = createHostedOperatorClient({
    endpoint: "https://operator.example",
    fetch: async (url, init) =>
      await handler(new Request(url instanceof Request ? url.url : url, init)),
    ownerContext,
    token: async () => "fixture-service-identity",
  });
  return {
    applied,
    approve() {
      approved = true;
    },
    client,
    deps,
    handler,
    known() {
      uncertain = false;
    },
    loseFence() {
      fence = false;
    },
    revoke() {
      member = false;
    },
    get row() {
      return row;
    },
    set row(value) {
      row = value;
    },
    unknown() {
      uncertain = true;
    },
  };
};
const prepared = async (f: ReturnType<typeof fixture>) => {
  const planned = await f.client.request({ action: "plan", operation: "prepare", selection });
  expect(planned.status).toBe("planned");
  return {
    action: "execute" as const,
    callId: "actual-eve-call",
    operationRef: z.uuid().parse(planned.operationRef),
    planDigest: z.string().parse(planned.planDigest),
    selection,
  };
};

const adoptedGatewayPlan = () => {
  const sourceOperation = "b209b89b-0bad-4a60-820f-4e29d5e5a4cc";
  const keys = [
    "AUTH_DATABASE_RESOURCE",
    "PLATFORM_AUTH_DATABASE_URL",
    "PLATFORM_GATEWAY_PROTECTED_APPLICATIONS",
    "PLATFORM_REALM_OPERATOR_LINK_CONFIG",
    "PLATFORM_GATEWAY_PROJECT_BINDINGS",
  ] as const;
  const gatewayEnvironment = keys.map((key) => ({
    branch: selection.branch,
    comment: `App Builder protected operator ${sourceOperation}`,
    id: `env_${key}`,
    key,
    operationRef: sourceOperation,
    projectId: "prj_gateway",
    target: ["preview"],
    type: "encrypted",
    valueSha256: "d".repeat(64),
  }));
  return hostedOperatorPlanSchema.parse({
    ...plan,
    authAdoption: {
      gatewayEnvironment,
      kind: "owned-journal-auth-v1",
      resource: {
        authDatabase: plan.authDatabase,
        branchId: plan.neon.branchId,
        endpoint: plan.neon.endpoint,
        endpointId: "ep-fixture",
        projectId: plan.neon.projectId,
      },
      source: {
        checkpointSha256: "d".repeat(64),
        journalDigest: "e".repeat(64),
        operationRef: sourceOperation,
        planDigest: "f".repeat(64),
        selection: { ...selection, appId: "source-app" },
      },
    },
    authSchema: {
      artifactRef: "auth-plan",
      installer: plan.installer,
      planDigest: "a".repeat(64),
      targetDigest: "b".repeat(64),
    },
    bootstrap: { endpointId: "ep-fixture", maintenanceDatabase: "neondb", role: "neondb_owner" },
    effects: [
      {
        description: "Observe adopted Auth",
        id: "auth-resources",
        kind: "resources",
        resourceId: plan.authDatabase.resourceId,
      },
      {
        description: "Prepare independent app",
        id: "app-resources",
        kind: "resources",
        resourceId: plan.appDatabase.resourceId,
      },
      ...plan.effects.filter((effect) => effect.kind !== "resources"),
      { description: "Bind shared Gateway", id: "gateway-bindings", kind: "gateway-bindings" },
    ],
    gatewayBindings: {
      authBrowserOrigin: "https://auth-preview.example.test",
      builderCallbackOrigin: "https://builder.example",
      catalogAppIds: [selection.appId],
      operatorOrigin: "https://operator.example",
      sourceWorkload: {
        audience: "https://vercel.com",
        environment: "preview",
        issuer: "https://oidc.vercel.com/team_fixture",
        ownerId: "team_fixture",
        projectId: "prj_gateway",
        subject: "fixture-gateway",
      },
    },
    resourcesInstaller: plan.installer,
  });
};

const completedOwnerBootstrap = async (normalActors = false) => {
  const f = fixture();
  const gatewayPlan = adoptedGatewayPlan();
  const bootstrapPlan = hostedOperatorPlanSchema.parse({
    ...plan,
    access: [],
    authSchema: gatewayPlan.authSchema,
    bootstrap: gatewayPlan.bootstrap,
    gatewayBindings: gatewayPlan.gatewayBindings,
    resourcesInstaller: gatewayPlan.resourcesInstaller,
    stage: "auth-bootstrap",
    effects: [
      {
        description: "Prepare Auth resource",
        id: "resources:auth",
        kind: "resources",
        resourceId: plan.authDatabase.resourceId,
      },
      {
        description: "Prepare app resource",
        id: "resources:app",
        kind: "resources",
        resourceId: plan.appDatabase.resourceId,
      },
      { description: "Prepare Auth", id: "install:auth", kind: "install" },
      { description: "Bind Gateway", id: "gateway-bindings", kind: "gateway-bindings" },
    ],
    ...(normalActors
      ? {
          normalActorProgram: {
            version: 1,
            appId: selection.appId,
            origin: plan.publicGateway?.origin,
            actors: [
              {
                actorKey: "owner",
                account: "capture-existing",
                email: "owner@example.test",
                name: "Owner",
              },
            ],
            organizations: [],
            memberships: [],
            appAccess: [],
          },
        }
      : {}),
  });
  f.deps.plan = async () => bootstrapPlan;
  f.deps.verifyAuthReadiness = async () => ({
    assetSha256: "1".repeat(64),
    catalogFingerprint: "2".repeat(64),
    database: plan.authDatabase.database,
    runtimeRole: plan.authDatabase.runtimeRole,
    targetDigest: z.string().parse(bootstrapPlan.authSchema?.targetDigest),
    observedAt: new Date().toISOString(),
  });
  const request = await prepared(f);
  f.approve();
  expect((await f.client.request(request)).status).toBe("auth-schema-prepared");
  const current = f.row;
  if (current?.record.operator === undefined) {
    throw new Error("Missing bootstrap journal");
  }
  const identityLink = {
    audience: z.string().parse(bootstrapPlan.gatewayBindings?.operatorOrigin),
    authResourceId: bootstrapPlan.authDatabase.resourceId,
    bootstrapPlanDigest: request.planDigest,
    browserOrigin: z.string().parse(bootstrapPlan.gatewayBindings?.authBrowserOrigin),
    endpointOrigin: z.string().parse(bootstrapPlan.deploymentBoundary?.verification.gatewayOrigin),
    issuer: z.string().parse(bootstrapPlan.deploymentBoundary?.verification.publicOrigin),
    ownerSessionId: selection.sessionId,
    organizationId: null,
    nonceSha256: "d".repeat(64),
    expiresAt: "2026-10-01T00:00:00Z",
    consumedAt: "2026-09-30T23:59:00Z",
    proofRef: "canonical-owner-proof",
    proofSha256: "e".repeat(64),
  };
  f.row = {
    ...current,
    record: hostedRuntimeJournalRecordSchema.parse({
      ...current.record,
      operator: { ...current.record.operator, identityLink },
    }),
  };
  return { f, request, identityLink };
};

describe("legacy owner bootstrap public readiness", () => {
  it("finishes the same approved owner phase after canonical proof consumption without claiming app readiness", async () => {
    const { f, request } = await completedOwnerBootstrap();
    const result = await f.client.request(request);
    expect(result).toMatchObject({
      status: "prepared",
      authenticatedBehavior: "unassessed",
      operationRef: request.operationRef,
    });
    expect(result).not.toHaveProperty("appUrl");
    expect(result).not.toHaveProperty("nativePreview");
    expect(result).not.toHaveProperty("proof");
    await expect(
      f.client.bindings({ action: "bindings", operationRef: request.operationRef, selection }),
    ).rejects.toMatchObject({ code: "auth_identity_required" });
  });

  it("keeps a pending owner identity link at Auth schema readiness", async () => {
    const { f, request } = await completedOwnerBootstrap();
    const link = f.row?.record.operator?.identityLink;
    if (link === undefined) {
      throw new Error("Missing identity link");
    }
    delete link.consumedAt;
    delete link.proofRef;
    delete link.proofSha256;
    expect((await f.client.request(request)).status).toBe("auth-schema-prepared");
  });

  it("preserves the normal actor program stage handoff after owner capture", async () => {
    const { f, request } = await completedOwnerBootstrap(true);
    expect((await f.client.request(request)).status).toBe("auth-schema-prepared");
  });

  it("does not reuse proof captured for a different approved plan", async () => {
    const { f, request } = await completedOwnerBootstrap();
    const link = f.row?.record.operator?.identityLink;
    if (link === undefined) {
      throw new Error("Missing identity link");
    }
    link.bootstrapPlanDigest = "f".repeat(64);
    expect((await f.client.request(request)).status).toBe("auth-schema-prepared");
  });

  it.each([
    "ownerSessionId",
    "authResourceId",
    "browserOrigin",
    "proofRef",
    "proofSha256",
  ] as const)(
    "refuses owner readiness when canonical %s is missing or mismatched",
    async (field) => {
      const { f, request } = await completedOwnerBootstrap();
      const link = f.row?.record.operator?.identityLink;
      if (link === undefined) {
        throw new Error("Missing identity link");
      }
      if (field === "proofRef") {
        delete link.proofRef;
      } else if (field === "proofSha256") {
        delete link.proofSha256;
      } else {
        link[field] =
          field === "browserOrigin" ? "https://other.example.test" : "other-owner-resource";
      }
      expect((await f.client.request(request)).status).toBe("blocked");
    },
  );
});

describe("protected hosted operator boundary", () => {
  it("serves consent-only setup before full resource configuration and refuses planning/effects", async () => {
    const f = fixture();
    const deps = composeHostedOperatorAuthorizationDependencies(
      {
        builderCallbackOrigin: "https://builder.example",
        builderWorkload: {
          audience: "https://vercel.com/team",
          environment: "production",
          issuer: "https://oidc.vercel.com/team",
          ownerId: "team",
          projectId: "builder",
          subject: "builder-subject",
        },
        operatorWorkload: {
          audience: "https://vercel.com/team",
          environment: "preview",
          issuer: "https://oidc.vercel.com/team",
          ownerId: "team",
          projectId: "operator",
        },
      },
      {
        assertCurrent: async () => {
          await Promise.resolve();
        },
        authorize: async () => await Promise.resolve({ authority, ownerContext }),
      },
    );
    expect(deps.neonAuthorization).toBeDefined();
    await expect(deps.plan({ action: "prepare", authority, target })).rejects.toMatchObject({
      code: "protected_operator_required",
    });
    await expect(
      deps.withResourceLease(
        { authority, operationRef: "00000000-0000-4000-8000-000000000001", plan, target },
        async () => {
          await Promise.resolve();
        },
      ),
    ).rejects.toMatchObject({ code: "protected_operator_required" });
    expect(f.row).toBeUndefined();
  });
  it("uses the existing owner-authorized client/service path for consent before any plan or journal", async () => {
    const f = fixture();
    let activeOwner = true;
    const authorizeConsent = vi.fn<
      NonNullable<ProtectedHostedOperatorDependencies["authorizeNeonConsent"]>
    >(async () => {
      if (!activeOwner) {
        throw new HostedOperatorError("authorization_required");
      }
      return await Promise.resolve({ authority, ownerContext });
    });
    f.deps.authorizeNeonConsent = authorizeConsent;
    const neonAuthorization = vi.fn<
      NonNullable<ProtectedHostedOperatorDependencies["neonAuthorization"]>
    >(async () => ({
      challenge: {
        displayName: "Connect Neon",
        url: "https://vercel.com/connect/authorize?opaque",
      },
      status: "authorization-started",
    }));
    f.deps.neonAuthorization = neonAuthorization;
    const result = await f.client.neonAuthorization({
      action: "neon-authorization",
      callbackUrl: "https://builder.example/callback",
      phase: "start",
      sessionId: selection.sessionId,
    });
    expect(result.status).toBe("authorization-started");
    expect(neonAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({ authority, ownerContext }),
      { callbackUrl: "https://builder.example/callback", phase: "start" },
    );
    expect(f.row).toBeUndefined();
    expect(f.deps.plan).not.toHaveBeenCalled();
    expect(f.deps.executeEffect).not.toHaveBeenCalled();
    activeOwner = false;
    await expect(
      f.client.neonAuthorization({
        action: "neon-authorization",
        phase: "complete",
        sessionId: selection.sessionId,
      }),
    ).rejects.toMatchObject({ code: "authorization_required" });
    expect(neonAuthorization).toHaveBeenCalledTimes(1);
  });
  it("prepares actual Auth metadata without app readiness and resumes a freshly approved full plan", async () => {
    const f = fixture();
    const bootstrap = {
      endpointId: "ep_fixture",
      maintenanceDatabase: "neondb",
      role: "neondb_owner",
    };
    const resourcesInstaller = { reference: "neon-resource-bootstrap-v1", sha256: "c".repeat(64) };
    const authSchema = {
      artifactRef: "auth-plan",
      installer: { reference: "auth-protected-installer-v1", sha256: "f".repeat(64) },
      planDigest: "d".repeat(64),
      targetDigest: "e".repeat(64),
    };
    const resources = [
      {
        description: "Prepare owned Auth resource",
        id: "resources:auth",
        kind: "resources",
        resourceId: plan.authDatabase.resourceId,
      },
      {
        description: "Prepare owned app resource",
        id: "resources:app",
        kind: "resources",
        resourceId: plan.appDatabase.resourceId,
      },
    ];
    const authEffect = {
      description: "Prepare exact Auth schema",
      id: "install:auth",
      kind: "install",
    };
    const bootstrapPlan = hostedOperatorPlanSchema.parse({
      ...plan,
      access: [],
      authSchema,
      bootstrap,
      effects: [...resources, authEffect],
      resourcesInstaller,
      stage: "auth-bootstrap",
    });
    f.deps.plan = async () => bootstrapPlan;
    f.deps.verifyAuthReadiness = vi.fn(
      async () =>
        await Promise.resolve({
          assetSha256: "1".repeat(64),
          catalogFingerprint: "2".repeat(64),
          database: plan.authDatabase.database,
          observedAt: new Date().toISOString(),
          runtimeRole: plan.authDatabase.runtimeRole,
          targetDigest: authSchema.targetDigest,
        }),
    );
    f.deps.verify = vi.fn(f.deps.verify);
    f.deps.bindings = vi.fn(f.deps.bindings);
    const first = await prepared(f);
    f.approve();
    expect((await f.client.request(first)).status).toBe("auth-schema-prepared");
    expect(f.deps.verify).not.toHaveBeenCalled();
    expect(f.deps.bindings).not.toHaveBeenCalled();
    const receipts = f.row?.record.operator?.receipts;
    expect(receipts).toHaveLength(3);
    expect(f.row?.record.environmentBound).toBe(false);
    let retainedAuth = structuredClone(f.row?.record.retainedAuth);
    expect(retainedAuth).toMatchObject({
      approvalId: "durable-human-decision",
      approvedByCallId: first.callId,
      operationRef: first.operationRef,
      plan: bootstrapPlan,
      planDigest: first.planDigest,
      receipts,
    });
    // A separately approved completed bootstrap supersedes the earlier bootstrap's
    // delivery provenance, while account preparation keeps its own approval epoch.
    const renewedBootstrap = hostedOperatorPlanSchema.parse({
      ...bootstrapPlan,
      release: { ...bootstrapPlan.release, id: "refreshed-auth-bootstrap" },
    });
    f.deps.plan = async () => renewedBootstrap;
    const refreshed = await prepared(f);
    expect(refreshed.operationRef).not.toBe(first.operationRef);
    expect((await f.client.request(refreshed)).status).toBe("auth-schema-prepared");
    retainedAuth = structuredClone(f.row?.record.retainedAuth);
    expect(retainedAuth).toMatchObject({
      approvedByCallId: refreshed.callId,
      operationRef: refreshed.operationRef,
      plan: renewedBootstrap,
      planDigest: refreshed.planDigest,
    });
    const fullPlan = hostedOperatorPlanSchema.parse({
      ...plan,
      authSchema,
      bootstrap,
      effects: [...resources, authEffect, ...plan.effects.slice(1)],
      resourcesInstaller,
      stage: "app",
    });
    f.deps.plan = async () => fullPlan;
    const currentApproval = f.deps.readApproval;
    f.deps.readApproval = async (input) =>
      input.planDigest === refreshed.planDigest ? await currentApproval(input) : null;
    const renewed = await prepared(f);
    expect(await f.client.request(renewed)).toMatchObject({
      code: "authorization_required",
      status: "blocked",
    });
    f.deps.readApproval = currentApproval;
    expect(renewed.planDigest).not.toBe(first.planDigest);
    expect(f.row?.record.operator?.receipts).toEqual(receipts);
    expect((await f.client.request(renewed)).status).toBe("prepared");
    expect(f.deps.verify).toHaveBeenCalledTimes(1);
    expect(f.row?.record.retainedAuth).toEqual(retainedAuth);
  });

  it("materializes existing complete Auth provenance before source cleanup and keeps it across CAS retries", async () => {
    const f = fixture();
    const authSchema = {
      artifactRef: "auth-plan",
      installer: { reference: "auth-protected-installer-v1", sha256: "f".repeat(64) },
      planDigest: "d".repeat(64),
      targetDigest: "e".repeat(64),
    };
    const sourcePlan = hostedOperatorPlanSchema.parse({ ...plan, authSchema });
    f.deps.plan = async () => sourcePlan;
    const source = await prepared(f);
    f.approve();
    await f.client.request(source);
    const completed = f.row;
    if (completed?.record.operator === undefined) {
      throw new Error("Missing completed source journal");
    }
    const readiness = {
      assetSha256: "1".repeat(64),
      catalogFingerprint: "2".repeat(64),
      database: plan.authDatabase.database,
      observedAt: new Date().toISOString(),
      runtimeRole: plan.authDatabase.runtimeRole,
      targetDigest: authSchema.targetDigest,
    };
    const gatewayEnvironment = [
      {
        branch: selection.branch,
        comment: `App Builder protected operator ${source.operationRef}`,
        id: "env_shared_auth",
        key: "AUTH_DATABASE_RESOURCE",
        operationRef: source.operationRef,
        projectId: "prj_gateway",
        valueSha256: "a".repeat(64),
      },
    ];
    // Existing v1 sources have saved readiness but no retained provenance field.
    f.row = {
      ...completed,
      record: hostedRuntimeJournalRecordSchema.parse({
        ...completed.record,
        operator: { ...completed.record.operator, authPreparation: readiness, gatewayEnvironment },
      }),
    };
    const expected = retainedOperatorAuthFromJournal(f.row.record);
    expect(expected).toBeDefined();
    const cleanupPlan = hostedOperatorPlanSchema.parse({
      ...sourcePlan,
      action: "cleanup",
      effects: [
        { description: "Revoke access", id: "revoke", kind: "revoke" },
        { description: "Remove app bindings", id: "remove-bindings", kind: "remove-bindings" },
        { description: "Retire app", id: "retire", kind: "retire" },
      ],
    });
    f.deps.plan = async () => cleanupPlan;
    const { readApproval } = f.deps;
    f.deps.readApproval = async () => null;
    expect(
      await f.client.request({ action: "plan", operation: "cleanup", selection }),
    ).toMatchObject({
      code: "authorization_required",
      status: "blocked",
    });
    expect(f.row.record.retainedAuth).toBeUndefined();
    expect(f.row.record.operator?.operationRef).toBe(source.operationRef);
    const beforeRace = structuredClone(f.row);
    f.deps.readApproval = async (input) => {
      if (f.row?.record.privateState !== undefined) {
        f.row.record.privateState.encryptedToken = "replaced-source-ciphertext";
      }
      return await readApproval(input);
    };
    expect(
      await f.client.request({ action: "plan", operation: "cleanup", selection }),
    ).toMatchObject({ code: "operation_in_progress", status: "blocked" });
    expect(f.row?.record.retainedAuth).toBeUndefined();
    f.row = beforeRace;
    f.deps.readApproval = vi.fn(readApproval);
    const { compareAndSet } = f.deps.store;
    let missed = false;
    f.deps.store.compareAndSet = async (input) => {
      if (!missed && input.record.operator?.plan.action === "cleanup") {
        missed = true;
        if (f.row !== undefined) {
          f.row = { ...f.row, revision: f.row.revision + 1 };
        }
        // oxlint-disable-next-line unicorn/no-useless-undefined -- A stale CAS returns no row.
        return undefined;
      }
      return await compareAndSet(input);
    };
    const cleanup = await f.client.request({ action: "plan", operation: "cleanup", selection });
    expect(cleanup.status).toBe("planned");
    expect(missed).toBe(true);
    expect(f.deps.readApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "prepare",
        callId: source.callId,
        planDigest: source.planDigest,
      }),
    );
    expect(f.row?.record.retainedAuth).toEqual(expected);
    expect(f.row?.record.operator?.authPreparation).toEqual(readiness);
    const updatedRows = gatewayEnvironment.map((row) => ({
      ...row,
      pendingOperationRef: z.uuid().parse(cleanup.operationRef),
      pendingValueSha256: "b".repeat(64),
    }));
    const { executeEffect } = f.deps;
    f.deps.executeEffect = async (input) => {
      if (input.effect.kind === "revoke") {
        await input.checkpointGatewayEnvironment?.(updatedRows);
      }
      return await executeEffect(input);
    };
    expect(
      (
        await f.client.request({
          ...source,
          callId: "source-cleanup",
          operationRef: z.uuid().parse(cleanup.operationRef),
          planDigest: z.string().parse(cleanup.planDigest),
        })
      ).status,
    ).toBe("cleaned");
    const updatedExpected = { ...expected, gatewayEnvironment: updatedRows };
    expect(f.row?.record.retainedAuth).toEqual(updatedExpected);
    expect(f.row?.record.operator?.fenceGeneration).toBeGreaterThan(expected?.fenceGeneration ?? 0);
    expect(f.row?.record.retainedAuth?.fenceGeneration).toBe(expected?.fenceGeneration);
    f.deps.plan = async () => ({ ...sourcePlan, contextId: "replacement-app" });
    expect((await prepared(f)).planDigest).not.toBe(source.planDigest);
    expect(f.row?.record.retainedAuth).toEqual(updatedExpected);
    f.deps.plan = async () => ({
      ...sourcePlan,
      authSchema: { ...authSchema, targetDigest: "f".repeat(64) },
      contextId: "replacement-app",
    });
    await prepared(f);
    expect(f.row?.record.retainedAuth).toBeUndefined();
    expect(f.row?.record.operator?.authPreparation).toBeUndefined();
  });

  it("captures ordinary completed prepare only with approved complete receipts and saved Auth readiness", async () => {
    const f = fixture();
    const authSchema = {
      artifactRef: "auth-plan",
      installer: { reference: "auth-protected-installer-v1", sha256: "f".repeat(64) },
      planDigest: "d".repeat(64),
      targetDigest: "e".repeat(64),
    };
    f.deps.plan = async () => ({ ...plan, authSchema });
    const request = await prepared(f);
    const initial = f.row;
    if (initial?.record.operator === undefined) {
      throw new Error("Missing planned source journal");
    }
    f.row = {
      ...initial,
      record: hostedRuntimeJournalRecordSchema.parse({
        ...initial.record,
        operator: {
          ...initial.record.operator,
          authPreparation: {
            assetSha256: "1".repeat(64),
            catalogFingerprint: "2".repeat(64),
            database: plan.authDatabase.database,
            observedAt: new Date().toISOString(),
            runtimeRole: plan.authDatabase.runtimeRole,
            targetDigest: authSchema.targetDigest,
          },
        },
      }),
    };
    expect(retainedOperatorAuthFromJournal(f.row.record)).toBeUndefined();
    expect((await f.client.request(request)).code).toBe("authorization_required");
    expect(f.row?.record.retainedAuth).toBeUndefined();
    f.approve();
    expect((await f.client.request(request)).status).toBe("prepared");
    const complete = f.row?.record;
    if (complete?.operator === undefined) {
      throw new Error("Missing prepared source journal");
    }
    expect(complete.retainedAuth).toMatchObject({
      approvedByCallId: request.callId,
      operationRef: request.operationRef,
      planDigest: request.planDigest,
      receipts: complete.operator.receipts,
    });
    expect(
      retainedOperatorAuthFromJournal({
        ...complete,
        approvedByCallId: "operator:unapproved-plan",
      }),
    ).toBeUndefined();
    expect(
      retainedOperatorAuthFromJournal({
        ...complete,
        // oxlint-disable-next-line sonarjs/no-undefined-assignment -- Missing optional approval cannot mint ownership.
        operator: { ...complete.operator, approvalId: undefined },
      }),
    ).toBeUndefined();
    expect(
      retainedOperatorAuthFromJournal({
        ...complete,
        operator: { ...complete.operator, receipts: complete.operator.receipts.slice(1) },
      }),
    ).toBeUndefined();
    expect(
      retainedOperatorAuthFromJournal({
        ...complete,
        operator: { ...complete.operator, pendingEffectId: "install" },
      }),
    ).toBeUndefined();
    expect(
      retainedOperatorAuthFromJournal({
        ...complete,
        // oxlint-disable-next-line sonarjs/no-undefined-assignment -- Missing optional readiness cannot mint ownership.
        operator: { ...complete.operator, authPreparation: undefined },
      }),
    ).toBeUndefined();
    expect(
      retainedOperatorAuthFromJournal({
        ...complete,
        operator: {
          ...complete.operator,
          fenceGeneration: (complete.operator.fenceGeneration ?? 0) + 1,
        },
      }),
    ).toBeUndefined();
  });

  it("CAS-checkpoints managed environment ownership and preserves it for cleanup", async () => {
    const f = fixture();
    const original = f.deps.executeEffect;
    f.deps.executeEffect = async (input) => {
      if (input.effect.kind === "bindings") {
        if (input.checkpointManagedEnvironment === undefined) {
          throw new Error("Missing real CAS checkpoint");
        }
        const row = {
          branch: input.target.branch,
          comment: `App Builder protected operator ${input.operationRef}`,
          id: "env_owned",
          key: "PLATFORM_ORIGIN",
          operationRef: input.operationRef,
          projectId: input.target.projectId,
        };
        await input.checkpointManagedEnvironment([row]);
        expect(f.row?.record.operator?.managedEnvironment).toEqual([row]);
        await expect(
          input.checkpointManagedEnvironment([
            {
              ...row,
              comment: "App Builder protected operator 00000000-0000-4000-8000-000000000000",
              operationRef: "00000000-0000-4000-8000-000000000000",
            },
          ]),
        ).rejects.toMatchObject({ code: "resource_mismatch" });
      }
      return await original(input);
    };
    const preparedInput = await prepared(f);
    f.approve();
    const outcome = await f.client.request(preparedInput);
    expect(outcome).toMatchObject({ status: "prepared" });
    const rows = f.row?.record.operator?.managedEnvironment;
    expect(rows).toHaveLength(1);
    const cleanupPlan = hostedOperatorPlanSchema.parse({
      ...plan,
      action: "cleanup",
      effects: [
        { description: "Revoke current authority", id: "revoke", kind: "revoke" },
        {
          description: "Remove exact owned bindings",
          id: "remove-bindings",
          kind: "remove-bindings",
        },
        { description: "Retire owned resources", id: "retire", kind: "retire" },
      ],
    });
    f.deps.plan = async () => cleanupPlan;
    expect(
      (await f.client.request({ action: "plan", operation: "cleanup", selection })).status,
    ).toBe("planned");
    expect(f.row?.record.operator?.managedEnvironment).toEqual(rows);
    expect(f.row?.record.operator?.operationRef).not.toBe(preparedInput.operationRef);
  });

  it("rejects missing or reordered authorization phases", () => {
    for (const effects of [plan.effects.slice(1), plan.effects.toReversed(), [plan.effects[3]]]) {
      expect(hostedOperatorPlanSchema.safeParse({ ...plan, effects }).success).toBe(false);
    }
    expect(
      hostedOperatorPlanSchema.safeParse({
        ...plan,
        action: "cleanup",
        effects: [
          { description: "Retire before revocation", id: "retire", kind: "retire" },
          { description: "Late revoke", id: "revoke", kind: "revoke" },
        ],
      }).success,
    ).toBe(false);
  });
  it("rejects expired preparation authority while preserving read-only status", async () => {
    const f = fixture();
    const request = await prepared(f);
    f.approve();
    f.deps.now = () => Date.parse("2028-01-01T00:00:00.000Z");
    const expiredHandler = createProtectedHostedOperatorHandler(f.deps);
    const client = createHostedOperatorClient({
      endpoint: "https://operator.example",
      fetch: async (url, init) =>
        await expiredHandler(new Request(url instanceof Request ? url.url : url, init)),
      token: async () => "fixture-service-identity",
    });
    expect((await client.request(request)).code).toBe("authorization_required");
    expect(
      (await client.request({ action: "status", operationRef: request.operationRef, selection }))
        .status,
    ).toBe("pending");
    expect(f.deps.executeEffect).not.toHaveBeenCalled();
  });
  it("is unavailable without a configured endpoint or all trusted service adapters", async () => {
    await expect(hostedOperatorClientForSession({}, "", {})).rejects.toThrow(
      "protected_operator_required",
    );
    expect(() =>
      createProtectedHostedOperatorHandler({
        ...fixture().deps,
        // @ts-expect-error Exercise invalid adapter startup supplied by an untyped module.
        authorize: null,
      }),
    ).toThrow("protected_operator_required");
  });
  it("plans without effects, exposes concrete approval scope and rejects caller-asserted approval", async () => {
    const f = fixture();
    const request = await prepared(f);
    expect(f.deps.executeEffect).not.toHaveBeenCalled();
    expect((await f.client.request(request)).code).toBe("authorization_required");
    expect(f.deps.executeEffect).not.toHaveBeenCalled();
    const description = publicApprovalDescription(
      { ...selection, plan, planDigest: operatorPlanDigest(plan) },
      "prepare-app-hosted-runtime",
    );
    expect(description).toContain("What will happen:");
    expect(description).toContain("Access and cost:");
    expect(description).toContain("synthetic-reviewer");
    expect(description).toContain("reviewer");
    expect(description).toContain("Fixture owner");
    expect(description).toContain("Retain while");
  });
  it("carries explicit prepared Preview intent through normal owner-authorized planning", async () => {
    const f = fixture();
    const result = await f.client.request({
      action: "plan",
      operation: "prepare",
      selection,
      releaseIntent: "prepared-preview",
    });
    expect(result.status).toBe("planned");
    expect(f.deps.plan).toHaveBeenCalledWith(
      expect.objectContaining({ action: "prepare", releaseIntent: "prepared-preview", target }),
    );
    expect(f.deps.executeEffect).not.toHaveBeenCalled();
  });
  it("re-exposes the same unapproved prepared Preview proposal on retry without effects", async () => {
    const f = fixture();
    f.deps.plan = vi.fn(async () => ({ ...plan, releaseIntent: "prepared-preview" as const }));
    const request = {
      action: "plan" as const,
      operation: "prepare" as const,
      selection,
      releaseIntent: "prepared-preview" as const,
    };
    const first = await f.client.request(request);
    const before = structuredClone(f.row);
    const second = await f.client.request(request);
    expect(second).toMatchObject({
      status: "planned",
      operationRef: first.operationRef,
      planDigest: first.planDigest,
      plan: first.plan,
    });
    expect(f.deps.plan).toHaveBeenCalledTimes(1);
    expect(f.row).toEqual(before);
    expect(f.deps.executeEffect).not.toHaveBeenCalled();
    const execution = await f.client.request({
      action: "execute",
      callId: "not-approved",
      operationRef: z.uuid().parse(second.operationRef),
      planDigest: z.string().parse(second.planDigest),
      selection,
    });
    expect(execution).toMatchObject({ status: "blocked", code: "authorization_required" });
    expect(f.deps.executeEffect).not.toHaveBeenCalled();
  });
  it("denies changed product input or revoked owner on pending prepared Preview retry", async () => {
    const f = fixture();
    f.deps.plan = vi.fn(async () => ({ ...plan, releaseIntent: "prepared-preview" as const }));
    const request = {
      action: "plan" as const,
      operation: "prepare" as const,
      selection,
      releaseIntent: "prepared-preview" as const,
    };
    await f.client.request(request);
    const before = structuredClone(f.row);
    const changed = await f.client.request({
      ...request,
      authSignupPolicy: {
        version: 1,
        appPath: "/",
        organizationId: "other-org",
        eligibility: "public",
        membershipRole: "member",
        appRoles: ["reviewer"],
      },
    });
    expect(changed).toMatchObject({ status: "blocked", code: "operation_in_progress" });
    expect(f.row).toEqual(before);
    f.revoke();
    expect(await f.client.request(request)).toMatchObject({
      status: "blocked",
      code: "authorization_required",
    });
    expect(f.deps.executeEffect).not.toHaveBeenCalled();
  });
  it("retains pending prepared Preview retry across harmless revision updates and denies operation replacement", async () => {
    const f = fixture();
    f.deps.plan = vi.fn(async () => ({ ...plan, releaseIntent: "prepared-preview" as const }));
    const request = {
      action: "plan" as const,
      operation: "prepare" as const,
      selection,
      releaseIntent: "prepared-preview" as const,
    };
    const first = await f.client.request(request);
    const authorize = f.deps.assertAuthorized;
    f.deps.assertAuthorized = async (input) => {
      await authorize(input);
      if (f.row !== undefined) {
        f.row.revision += 1;
        f.row.record.operator?.receipts.push({
          effectId: "resources",
          observedAt: "2026-10-21T00:00:00Z",
          resourceVersion: "inherited-observation",
        });
      }
    };
    expect(await f.client.request(request)).toMatchObject({
      status: "planned",
      operationRef: first.operationRef,
      planDigest: first.planDigest,
    });
    f.deps.assertAuthorized = async (input) => {
      await authorize(input);
      if (f.row?.record.operator !== undefined) {
        f.row.record.operator.operationRef = "00000000-0000-4000-8000-000000000002";
      }
    };
    expect(await f.client.request(request)).toMatchObject({
      status: "blocked",
      code: "operation_in_progress",
    });
    expect(f.deps.executeEffect).not.toHaveBeenCalled();
  });
  it("matches supplied signup input to the bound pending prepared Preview policy", async () => {
    const f = fixture();
    const policy = {
      version: 1 as const,
      appPath: "/",
      organizationId: "synthetic-org",
      eligibility: "public" as const,
      membershipRole: "member" as const,
      appRoles: ["reviewer"],
    };
    const pending = hostedOperatorPlanSchema.parse({
      ...plan,
      stage: "app",
      releaseIntent: "prepared-preview",
      authSignupPolicy: {
        ...policy,
        policyId: "owned-policy",
        authResourceId: plan.authDatabase.resourceId,
        appId: selection.appId,
        origin: plan.deploymentBoundary?.verification.publicOrigin,
      },
      effects: plan.effects.flatMap((effect) =>
        effect.kind === "access"
          ? [
              { id: "signup", kind: "auth-signup-policy", description: "Persist approved signup" },
              effect,
            ]
          : [effect],
      ),
    });
    f.deps.plan = vi.fn(async () => pending);
    const request = {
      action: "plan" as const,
      operation: "prepare" as const,
      selection,
      releaseIntent: "prepared-preview" as const,
      authSignupPolicy: policy,
    };
    const first = await f.client.request(request);
    expect(await f.client.request(request)).toMatchObject({
      status: "planned",
      planDigest: first.planDigest,
      operationRef: first.operationRef,
    });
    expect(f.deps.plan).toHaveBeenCalledTimes(1);
    expect(f.deps.executeEffect).not.toHaveBeenCalled();
  });
  it("requires a verified Gateway origin on newly planned operations", async () => {
    const f = fixture();
    f.deps.plan = async () => {
      const legacyPlan = { ...plan };
      delete legacyPlan.publicGateway;
      delete legacyPlan.deploymentBoundary;
      return legacyPlan;
    };
    const result = await f.client.request({ action: "plan", operation: "prepare", selection });
    expect(result.status).toBe("blocked");
    expect(result.code).toBe("resource_mismatch");
    expect(f.row).toBeUndefined();
  });
  it.each([undefined, "d".repeat(64)])(
    "rejects missing or mismatched manifest proof %s despite a valid schema identity",
    async (manifestSha256) => {
      const f = fixture();
      const request = await prepared(f);
      f.approve();
      f.deps.verify = async () => ({ ...proof, manifestSha256 });
      const result = await f.client.request(request);
      expect(result.status).toBe("blocked");
      expect(result.code).toBe("resource_mismatch");
      await expect(
        f.client.bindings({ action: "bindings", operationRef: request.operationRef, selection }),
      ).rejects.toThrow();
    },
  );
  it("executes only after durable approval and projects shared-context runtime roles without installer state", async () => {
    const f = fixture();
    const request = await prepared(f);
    f.approve();
    const result = await f.client.request(request);
    expect(result.status).toBe("prepared");
    expect(JSON.stringify(result)).not.toContain("ciphertext");
    const binding = await f.client.bindings({
      action: "bindings",
      operationRef: request.operationRef,
      selection,
    });
    expect(binding.environment).toEqual(environment);
    expect(binding.environment.PLATFORM_JWKS_URL).toBe(environment.PLATFORM_JWKS_URL);
    expect(Object.keys(binding).toSorted()).toEqual([
      "environment",
      "operationRef",
      "plan",
      "proof",
    ]);
    expect(JSON.stringify(binding)).not.toContain("state.json");
    await f.client.request(request);
    expect(f.deps.executeEffect).toHaveBeenCalledTimes(4);
  });
  it("persists explicitly approved schema tenants without adding access grants", async () => {
    const f = fixture();
    const selectedPlan = hostedOperatorPlanSchema.parse({
      ...plan,
      appInstallation: { customerIds: ["synthetic-org", "retained-owner-org"] },
    });
    f.deps.plan = async () => selectedPlan;
    const request = await prepared(f);
    f.approve();
    const execute = f.deps.executeEffect;
    f.deps.executeEffect = async (input) => {
      if (input.effect.kind === "install" || input.effect.kind === "access") {
        const contextDigest = (input.effect.kind === "install" ? "c" : "d").repeat(64);
        const recordCheckpoint = await input.bindWorkerContext({ contextDigest });
        const frame = {
          contextDigest,
          effectId: "schema-install",
          fenceGeneration: input.fenceGeneration,
          operationId: input.operationRef,
          receipt: { readbackSha256: "e".repeat(64), state: "applied" as const },
          resourceId: selectedPlan.appDatabase.resourceId,
          sequence: 1,
          tenantId: "retained-owner-org",
        };
        if (input.effect.kind === "install") {
          await expect(
            recordCheckpoint({ ...frame, resourceId: selectedPlan.authDatabase.resourceId }),
          ).rejects.toMatchObject({ code: "resource_mismatch" });
          await expect(
            recordCheckpoint({ ...frame, tenantId: "foreign-org" }),
          ).rejects.toMatchObject({ code: "resource_mismatch" });
          await recordCheckpoint(frame);
        } else {
          await expect(recordCheckpoint(frame)).rejects.toMatchObject({
            code: "resource_mismatch",
          });
          await recordCheckpoint({ ...frame, tenantId: "synthetic-org" });
        }
      }
      return await execute(input);
    };
    expect((await f.client.request(request)).status).toBe("prepared");
    expect(f.row?.record.operator?.plan.appInstallation).toEqual(selectedPlan.appInstallation);
    expect(f.row?.record.operator?.plan.access).toEqual(plan.access);
    expect(f.row?.record.operator?.workerCheckpoints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ parentEffectId: "install", tenantId: "retained-owner-org" }),
        expect.objectContaining({ parentEffectId: "access", tenantId: "synthetic-org" }),
      ]),
    );
  });

  it("binds nested worker checkpoints to the active parent effect and acknowledges only after CAS", async () => {
    const f = fixture();
    const request = await prepared(f);
    f.approve();
    const digest = "c".repeat(64);
    f.deps.executeEffect = vi.fn<ProtectedHostedOperatorDependencies["executeEffect"]>(
      async (input) => {
        await input.assertCurrent();
        if (input.effect.id === "resources") {
          const recordCheckpoint = await input.bindWorkerContext({ contextDigest: digest });
          const frame = {
            contextDigest: digest,
            effectId: "schema-install",
            fenceGeneration: input.fenceGeneration,
            operationId: input.operationRef,
            receipt: { readbackSha256: "d".repeat(64), state: "applied" as const },
            resourceId: plan.appDatabase.resourceId,
            sequence: 1,
            tenantId: "synthetic-org",
          };
          await recordCheckpoint(frame);
          const stored = f.row?.record.operator?.workerCheckpoints?.[0];
          expect(stored).toMatchObject({
            attemptId: input.workerAttemptId,
            contextDigest: digest,
            effectId: "schema-install",
            fenceGeneration: input.fenceGeneration,
            operationRef: input.operationRef,
            parentEffectId: input.effect.id,
            receipt: frame.receipt,
            resourceId: plan.appDatabase.resourceId,
            sequence: 1,
            tenantId: "synthetic-org",
          });
          await recordCheckpoint(frame);
          expect(f.row?.record.operator?.workerCheckpoints).toHaveLength(1);
          await expect(
            recordCheckpoint({ ...frame, resourceId: "unplanned-resource" }),
          ).rejects.toThrow("resource_mismatch");
          await expect(
            recordCheckpoint({ ...frame, tenantId: "unplanned-tenant" }),
          ).rejects.toThrow("resource_mismatch");
          await expect(recordCheckpoint({ ...frame, sequence: 3 })).rejects.toThrow(
            "reconciliation_required",
          );
          await expect(
            recordCheckpoint({
              ...frame,
              receipt: { readbackSha256: "e".repeat(64), state: "applied" },
            }),
          ).rejects.toThrow("reconciliation_required");
          await expect(
            recordCheckpoint({ ...frame, contextDigest: "f".repeat(64) }),
          ).rejects.toThrow("resource_mismatch");
          await expect(input.bindWorkerContext({ contextDigest: "f".repeat(64) })).rejects.toThrow(
            "reconciliation_required",
          );
        }
        return {
          effectId: input.effect.id,
          fenceGeneration: input.fenceGeneration,
          observedAt: new Date().toISOString(),
          resourceVersion: "worker-checkpoint-fixture",
        };
      },
    );

    const result = await f.client.request(request);
    expect(result.status).toBe("prepared");
    expect(result).not.toHaveProperty("workerCheckpoints");
    expect(f.row?.record.operator?.pendingEffectId).toBeUndefined();
    expect(f.row?.record.operator?.pendingEffectAttempt).toBeUndefined();
    expect(f.row?.record.operator?.workerCheckpoints).toHaveLength(1);
  });
  it("persists unknown worker readback and requires parent reconciliation before a fresh attempt", async () => {
    const f = fixture();
    const request = await prepared(f);
    f.approve();
    const digest = "a".repeat(64);
    let unknownObserved = false;
    let firstAttemptId = "";
    f.deps.executeEffect = vi.fn<ProtectedHostedOperatorDependencies["executeEffect"]>(
      async (input) => {
        firstAttemptId = input.workerAttemptId;
        const recordCheckpoint = await input.bindWorkerContext({ contextDigest: digest });
        await recordCheckpoint({
          contextDigest: digest,
          effectId: "schema-install",
          fenceGeneration: input.fenceGeneration,
          operationId: input.operationRef,
          receipt: { state: "unknown" },
          resourceId: plan.appDatabase.resourceId,
          sequence: 1,
        });
        const persistedUnknown = hostedOperatorRecordSchema.parse(f.row?.record.operator)
          .workerCheckpoints?.[0];
        expect(persistedUnknown?.receipt.state).toBe("unknown");
        throw new HostedOperatorError("reconciliation_required");
      },
    );
    const blockedAfterUnknown = await f.client.request(request);
    expect(blockedAfterUnknown.code).toBe("reconciliation_required");
    expect(f.row?.record.operator?.pendingEffectAttempt?.id).toBe(firstAttemptId);

    f.deps.reconcile = vi.fn<ProtectedHostedOperatorDependencies["reconcile"]>(async (input) => {
      if (input.workerCheckpoints.some((checkpoint) => checkpoint.receipt.state === "unknown")) {
        unknownObserved = true;
        return { status: "unknown" as const };
      }
      return { status: "absent" as const };
    });
    const blockedByReconciliation = await f.client.request(request);
    expect(blockedByReconciliation.code).toBe("reconciliation_required");
    expect(unknownObserved).toBe(true);
    expect(f.deps.executeEffect).toHaveBeenCalledTimes(1);

    let retryAttemptId = "";
    f.deps.reconcile = vi.fn(async () => ({ status: "absent" as const }));
    f.deps.executeEffect = vi.fn<ProtectedHostedOperatorDependencies["executeEffect"]>(
      async (input) => {
        if (input.effect.id === "resources") {
          retryAttemptId = input.workerAttemptId;
          const retryDigest = "b".repeat(64);
          const recordCheckpoint = await input.bindWorkerContext({ contextDigest: retryDigest });
          await recordCheckpoint({
            contextDigest: retryDigest,
            effectId: "schema-install",
            fenceGeneration: input.fenceGeneration,
            operationId: input.operationRef,
            receipt: { readbackSha256: "d".repeat(64), state: "applied" },
            resourceId: plan.appDatabase.resourceId,
            sequence: 1,
          });
        }
        return {
          effectId: input.effect.id,
          fenceGeneration: input.fenceGeneration,
          observedAt: new Date().toISOString(),
          resourceVersion: "reconciled-worker-fixture",
        };
      },
    );
    expect((await f.client.request(request)).status).toBe("prepared");
    expect(retryAttemptId).not.toBe(firstAttemptId);
    expect(
      f.row?.record.operator?.workerCheckpoints?.map((checkpoint) => [
        checkpoint.attemptId,
        checkpoint.receipt.state,
      ]),
    ).toEqual([
      [firstAttemptId, "unknown"],
      [retryAttemptId, "applied"],
    ]);
  });
  it.each([undefined, "7a44b7c5-02fd-4548-99f3-eaa2c178f03d"])(
    "reserves missing readback authority while preserving a matching attempt: %s",
    async (existingAttemptId) => {
      const f = fixture();
      const request = await prepared(f);
      f.approve();
      const { row } = f;
      if (row === undefined) {
        throw new Error("Planned fixture journal is missing");
      }
      const operator = hostedOperatorRecordSchema.parse(row.record.operator);
      const oldCheckpoint = {
        attemptId: "75d86faa-e356-441e-88e9-0fd808b4cd45",
        contextDigest: "a".repeat(64),
        effectId: "generated_app.prepare_schema_revision",
        fenceGeneration: 1,
        operationRef: request.operationRef,
        parentEffectId: "install",
        receipt: { state: "unknown" as const },
        resourceId: plan.appDatabase.resourceId,
        sequence: 1,
      };
      f.row = {
        ...row,
        record: hostedRuntimeJournalRecordSchema.parse({
          ...row.record,
          operator: {
            ...operator,
            fenceGeneration: 1,
            pendingEffectId: "install",
            pendingEffectAttempt:
              existingAttemptId === undefined
                ? undefined
                : { contextDigest: "b".repeat(64), id: existingAttemptId },
            receipts: [
              {
                effectId: "resources",
                observedAt: new Date().toISOString(),
                resourceVersion: "existing-resources",
              },
            ],
            workerCheckpoints: [oldCheckpoint],
          },
        }),
      };
      let readbackAttemptId = "";
      let executionAttemptId = "";
      const { reconcile, executeEffect } = f.deps;
      f.deps.reconcile = async (input) => {
        if (input.effect.id === "install") {
          const current = hostedOperatorRecordSchema.parse(f.row?.record.operator);
          expect(current.pendingEffectId).toBe(input.effect.id);
          readbackAttemptId = z.uuid().parse(current.pendingEffectAttempt?.id);
          expect(current.pendingEffectAttempt?.contextDigest).toBe(
            existingAttemptId === undefined ? undefined : "b".repeat(64),
          );
          expect(current.workerCheckpoints).toEqual([oldCheckpoint]);
          if (existingAttemptId !== undefined) {
            expect(readbackAttemptId).toBe(existingAttemptId);
          }
        }
        return await reconcile(input);
      };
      f.deps.executeEffect = async (input) => {
        if (input.effect.id === "install") {
          executionAttemptId = input.workerAttemptId;
        }
        return await executeEffect(input);
      };
      expect((await f.client.request(request)).status).toBe("prepared");
      expect(readbackAttemptId).not.toBe("");
      expect(executionAttemptId).not.toBe(readbackAttemptId);
      expect(f.row?.record.operator?.workerCheckpoints).toEqual([oldCheckpoint]);
      expect(f.row?.record.operator?.pendingEffectAttempt).toBeUndefined();
    },
  );
  it("serializes concurrent continuations of the same approved operation", async () => {
    const f = fixture();
    const request = await prepared(f);
    f.approve();
    const started = Promise.withResolvers<null>();
    const hold = Promise.withResolvers<null>();
    const real = f.deps.executeEffect;
    f.deps.executeEffect = async (input) => {
      started.resolve(null);
      await hold.promise;
      return await real(input);
    };
    const first = f.client.request(request);
    await started.promise;
    expect((await f.client.request(request)).code).toBe("operation_in_progress");
    hold.resolve(null);
    expect((await first).status).toBe("prepared");
    expect(real).toHaveBeenCalledTimes(4);
  });
  it("requires cleanup before replacing allocated resource identities", async () => {
    const f = fixture();
    const request = await prepared(f);
    f.approve();
    await f.client.request(request);
    const previous = structuredClone(f.row);
    for (const replacement of [
      { ...plan, neon: { ...plan.neon, branchId: "br_other" } },
      { ...plan, appDatabase: { ...plan.appDatabase, runtimeRole: "other_runtime" } },
      { ...plan, authDatabase: { ...plan.authDatabase, resourceId: "other-auth" } },
    ]) {
      f.deps.plan = async () => replacement;
      const next = await f.client.request({ action: "plan", operation: "prepare", selection });
      expect(next.code).toBe("resource_mismatch");
      expect(f.row).toEqual(previous);
    }
    expect(f.deps.executeEffect).toHaveBeenCalledTimes(4);
  });
  it("retains credentials across a current spec and release edit but requires fresh approval", async () => {
    const f = fixture();
    const request = await prepared(f);
    f.approve();
    await f.client.request(request);
    const credentials = structuredClone(f.row?.record.privateState);
    const readApproval = f.deps.readApproval;
    f.deps.readApproval = async (input) =>
      input.planDigest === request.planDigest ? await readApproval(input) : null;
    f.deps.plan = async () => ({
      ...plan,
      contextId: "accepted-next-spec",
      release: { ...plan.release, id: "release_next", sha256: "c".repeat(64) },
    });
    const next = await f.client.request({ action: "plan", operation: "prepare", selection });
    expect(next.status).toBe("planned");
    expect(next.operationRef).not.toBe(request.operationRef);
    expect(next.planDigest).not.toBe(request.planDigest);
    expect(f.row?.record.operator?.plan).toMatchObject({
      contextId: "accepted-next-spec",
      release: { id: "release_next", sha256: "c".repeat(64) },
    });
    expect(f.row?.record.privateState).toEqual(credentials);
    expect(f.row?.record.proof).toBeUndefined();
    expect(f.row?.record.environmentBound).toBe(false);
    expect(f.row?.record.operator?.receipts).toEqual([]);
    expect(f.row?.record.operator?.approvalId).toBeUndefined();
    expect(f.row?.record.approvedByCallId).toBe("operator:unapproved-plan");
    const unapproved = await f.client.request({
      action: "execute",
      callId: "next-human-decision",
      operationRef: z.uuid().parse(next.operationRef),
      planDigest: z.string().parse(next.planDigest),
      selection,
    });
    expect(unapproved).toMatchObject({ status: "blocked", code: "authorization_required" });
    expect(f.deps.executeEffect).toHaveBeenCalledTimes(4);
    expect(f.row?.record.privateState).toEqual(credentials);
    expect(f.row?.record.operator?.approvalId).toBeUndefined();
    await expect(
      f.client.bindings({
        action: "bindings",
        operationRef: z.uuid().parse(next.operationRef),
        selection,
      }),
    ).rejects.toThrow("operation_in_progress");
  });
  it("seeds adopted Gateway row identities and checkpoints interrupted PATCH recovery through the native handler", async () => {
    const f = fixture();
    const adopted = adoptedGatewayPlan();
    f.deps.plan = async () => adopted;
    const request = await prepared(f);
    f.approve();
    const canonical = (adopted.authAdoption?.gatewayEnvironment ?? []).map(
      ({ target: _target, type: _type, ...saved }) => {
        void _target;
        void _type;
        return saved;
      },
    );
    const { executeEffect } = f.deps;
    const snapshots: (ManagedOperatorEnvironmentRow[] | undefined)[] = [];
    f.deps.executeEffect = async (input) => {
      if (input.effect.kind === "gateway-bindings") {
        expect(input.gatewayEnvironmentRows).toBeUndefined();
        await input.checkpointGatewayEnvironment?.(canonical);
        snapshots.push(structuredClone(f.row?.record.operator?.gatewayEnvironment));
        const pending = canonical.map((saved) =>
          saved.key === "PLATFORM_GATEWAY_PROTECTED_APPLICATIONS"
            ? {
                ...saved,
                pendingOperationRef: input.operationRef,
                pendingValueSha256: "e".repeat(64),
              }
            : saved,
        );
        await input.checkpointGatewayEnvironment?.(pending);
        snapshots.push(structuredClone(f.row?.record.operator?.gatewayEnvironment));
        const settled = canonical.map((saved) =>
          saved.key === "PLATFORM_GATEWAY_PROTECTED_APPLICATIONS"
            ? { ...saved, valueSha256: "e".repeat(64) }
            : saved,
        );
        await input.checkpointGatewayEnvironment?.(settled);
      }
      return await executeEffect(input);
    };
    expect((await f.client.request(request)).status).toBe("prepared");
    expect(snapshots[0]).toEqual(canonical);
    expect(
      snapshots[1]?.find((saved) => saved.key === "PLATFORM_GATEWAY_PROTECTED_APPLICATIONS")
        ?.pendingOperationRef,
    ).toBe(request.operationRef);
    expect(
      f.row?.record.operator?.gatewayEnvironment?.find(
        (saved) => saved.key === "PLATFORM_GATEWAY_PROTECTED_APPLICATIONS",
      ),
    ).toMatchObject({
      operationRef: adopted.authAdoption?.source.operationRef,
      valueSha256: "e".repeat(64),
    });
  });

  it.each([
    "id",
    "key",
    "branch",
    "gitBranch",
    "projectId",
    "operationRef",
    "comment",
    "pendingOperationRef",
  ] as const)(
    "rejects changed adopted Gateway %s through the native checkpoint callback",
    async (field) => {
      const f = fixture();
      const adopted = adoptedGatewayPlan();
      f.deps.plan = async () => adopted;
      const request = await prepared(f);
      f.approve();
      const canonical = (adopted.authAdoption?.gatewayEnvironment ?? []).map(
        ({ target: _target, type: _type, ...saved }) => {
          void _target;
          void _type;
          return saved;
        },
      );
      const { executeEffect } = f.deps;
      f.deps.executeEffect = async (input) => {
        if (input.effect.kind === "gateway-bindings") {
          await input.checkpointGatewayEnvironment?.(canonical);
          const [original] = canonical;
          if (original === undefined) {
            throw new Error("Missing fixture row");
          }
          let changedValue: string | null = field === "key" ? "UNRELATED_KEY" : "foreign";
          if (field === "gitBranch") {
            changedValue = null;
          } else if (field === "operationRef" || field === "pendingOperationRef") {
            changedValue = "be91e77e-f23e-49d8-b6a8-a8a5acb36dfe";
          }
          const changed = { ...original, [field]: changedValue };
          if (field === "operationRef") {
            changed.comment = `App Builder protected operator ${changed.operationRef}`;
          }
          const row =
            field === "pendingOperationRef"
              ? { ...changed, pendingValueSha256: "e".repeat(64) }
              : changed;
          await expect(
            input.checkpointGatewayEnvironment?.([row, ...canonical.slice(1)]),
          ).rejects.toMatchObject({ code: "resource_mismatch" });
          expect(f.row?.record.operator?.gatewayEnvironment).toEqual(canonical);
        }
        return await executeEffect(input);
      };
      expect((await f.client.request(request)).status).toBe("prepared");
    },
  );

  it("plans and approves app cleanup after consuming Realm identity while retaining shared resources", async () => {
    const f = fixture();
    const appPlan = hostedOperatorPlanSchema.parse({
      ...plan,
      effects: [
        ...plan.effects,
        { description: "Bind shared Gateway", id: "gateway-bindings", kind: "gateway-bindings" },
      ],
      gatewayBindings: {
        authBrowserOrigin: "https://auth-preview.example.test",
        builderCallbackOrigin: "https://builder.example",
        catalogAppIds: [selection.appId],
        operatorOrigin: "https://operator.example",
        sourceWorkload: {
          audience: "https://vercel.com",
          environment: "preview",
          issuer: "https://oidc.vercel.com/team_fixture",
          ownerId: "team_fixture",
          projectId: "prj_gateway",
          subject: "fixture-gateway",
        },
      },
    });
    f.deps.plan = async () => appPlan;
    const request = await prepared(f);
    f.approve();
    expect((await f.client.request(request)).status).toBe("prepared");
    const current = f.row;
    if (current?.record.operator === undefined) {
      throw new Error("Missing completed app journal");
    }
    const sharedRows = [
      {
        branch: selection.branch,
        comment: `App Builder protected operator ${request.operationRef}`,
        id: "env_shared_auth",
        key: "AUTH_DATABASE_RESOURCE",
        operationRef: request.operationRef,
        projectId: "prj_gateway",
      },
    ];
    f.row = {
      ...current,
      record: hostedRuntimeJournalRecordSchema.parse({
        ...current.record,
        operator: {
          ...current.record.operator,
          gatewayEnvironment: sharedRows,
          identityLink: {
            audience: "https://builder.example",
            authResourceId: plan.authDatabase.resourceId,
            bootstrapPlanDigest: request.planDigest,
            browserOrigin: appPlan.gatewayBindings?.authBrowserOrigin,
            consumedAt: new Date().toISOString(),
            endpointOrigin: plan.deploymentBoundary?.verification.gatewayOrigin,
            expiresAt: "2027-01-01T00:00:00.000Z",
            issuer: plan.deploymentBoundary?.verification.publicOrigin,
            nonceSha256: "d".repeat(64),
            organizationId: "synthetic-org",
            ownerSessionId: selection.sessionId,
            proofRef: "retained-proof",
            proofSha256: "e".repeat(64),
          },
        },
      }),
    };
    const retainedCredentials = structuredClone(f.row.record.privateState);
    const cleanupPlan = hostedOperatorPlanSchema.parse({
      ...plan,
      action: "cleanup",
      effects: [
        { description: "Revoke app access", id: "revoke", kind: "revoke" },
        { description: "Remove app bindings", id: "remove-bindings", kind: "remove-bindings" },
        { description: "Retire app resource", id: "retire", kind: "retire" },
      ],
    });
    f.deps.plan = async () => cleanupPlan;
    const planned = await f.client.request({ action: "plan", operation: "cleanup", selection });
    expect(planned.status).toBe("planned");
    expect(f.row?.record.operator?.identityLink).toBeUndefined();
    expect(f.row?.record.privateState).toEqual(retainedCredentials);
    expect(f.row?.record.operator?.gatewayEnvironment).toEqual(sharedRows);
    const cleanup = {
      ...request,
      callId: "cleanup-consumed-identity",
      operationRef: z.uuid().parse(planned.operationRef),
      planDigest: z.string().parse(planned.planDigest),
    };
    const approval = f.deps.readApproval;
    f.deps.readApproval = async () => null;
    expect((await f.client.request(cleanup)).code).toBe("authorization_required");
    f.deps.readApproval = approval;
    expect((await f.client.request(cleanup)).status).toBe("cleaned");
    expect(f.row?.record.privateState).toEqual(retainedCredentials);
    expect(f.row?.record.operator?.gatewayEnvironment).toEqual(sharedRows);
  });
  it("requires cleanup approval and retains private shared Auth credentials for the next Preview", async () => {
    const f = fixture();
    const request = await prepared(f);
    f.approve();
    await f.client.request(request);
    const retainedCredentials = structuredClone(f.row?.record.privateState);
    const prepareGeneration = f.row?.record.operator?.fenceGeneration;
    expect(prepareGeneration).toBeGreaterThan(0);
    const cleanupPlanInput = {
      ...plan,
      action: "cleanup",
      effects: [
        { description: "Revoke this app access", id: "revoke", kind: "revoke" },
        {
          description: "Remove owned app bindings",
          id: "remove-bindings",
          kind: "remove-bindings",
        },
        { description: "Retain shared Auth while consumers exist", id: "retire", kind: "retire" },
      ],
    };
    delete cleanupPlanInput.publicGateway;
    delete cleanupPlanInput.deploymentBoundary;
    const cleanupPlan = hostedOperatorPlanSchema.parse(cleanupPlanInput);
    f.deps.plan = async () => cleanupPlan;
    const next = await f.client.request({ action: "plan", operation: "cleanup", selection });
    const cleanup = {
      ...request,
      callId: "cleanup-call",
      operationRef: z.uuid().parse(next.operationRef),
      planDigest: z.string().parse(next.planDigest),
    };
    const approval = f.deps.readApproval;
    f.deps.readApproval = async () => null;
    expect((await f.client.request(cleanup)).code).toBe("authorization_required");
    f.deps.readApproval = approval;
    expect((await f.client.request(cleanup)).status).toBe("cleaned");
    expect(f.row?.record.privateState).toEqual(retainedCredentials);
    expect(f.row?.record.proof).toBeUndefined();
    expect(f.row?.record.operator?.fenceGeneration).toBeGreaterThan(prepareGeneration ?? 0);
    await expect(
      f.client.bindings({
        action: "bindings",
        operationRef: z.uuid().parse(next.operationRef),
        selection,
      }),
    ).rejects.toThrow("operation_in_progress");
    f.deps.plan = async () => ({ ...plan, contextId: "replacement-after-cleanup" });
    const replacement = await f.client.request({ action: "plan", operation: "prepare", selection });
    expect(replacement.status).toBe("planned");
    expect(f.row?.record.privateState).toEqual(retainedCredentials);
    expect(f.row?.record.proof).toBeUndefined();
    expect(f.row?.record.environmentBound).toBe(false);
  });
  it("reconciles an effect applied before a timeout without allocating a second identity", async () => {
    const f = fixture();
    const request = await prepared(f);
    f.approve();
    const real = vi.mocked(f.deps.executeEffect);
    let crashed = false;
    f.deps.executeEffect = async (input) => {
      const receipt = await real(input);
      if (!crashed) {
        crashed = true;
        throw new Error("synthetic-admin-secret");
      }
      return receipt;
    };
    const first = await f.client.request(request);
    expect(first.status).toBe("blocked");
    expect(JSON.stringify(first)).not.toContain("synthetic-admin-secret");
    expect(f.row?.record.operator?.pendingEffectId).toBe("resources");
    const firstGeneration = f.row?.record.operator?.fenceGeneration;
    expect((await f.client.request(request)).status).toBe("prepared");
    expect(real).toHaveBeenCalledTimes(4);
    expect(f.row?.record.operator?.fenceGeneration).toBe(firstGeneration);
    expect(real.mock.calls.map(([input]) => input.fenceGeneration)).toEqual([
      firstGeneration,
      firstGeneration,
      firstGeneration,
      firstGeneration,
    ]);
  });
  it("does not retry when effect readback is unknown", async () => {
    const f = fixture();
    const request = await prepared(f);
    f.approve();
    f.unknown();
    expect((await f.client.request(request)).code).toBe("reconciliation_required");
    expect(f.deps.executeEffect).not.toHaveBeenCalled();
  });
  it("blocks access checkpoints that do not match the journaled fence generation", async () => {
    const f = fixture();
    const request = await prepared(f);
    f.approve();
    const real = f.deps.executeEffect;
    f.deps.executeEffect = async (input) => {
      const receipt = await real(input);
      return { ...receipt, fenceGeneration: input.fenceGeneration + 1 };
    };

    expect((await f.client.request(request)).code).toBe("reconciliation_required");
    expect(f.row?.record.operator?.receipts.map((receipt) => receipt.effectId)).toEqual([
      "resources",
      "install",
    ]);
    expect(f.row?.record.operator?.pendingEffectId).toBe("access");
    expect(f.row?.record.operator?.fenceGeneration).toBeGreaterThan(0);
  });
  it("rechecks revocation before the next effect", async () => {
    const f = fixture();
    const request = await prepared(f);
    f.approve();
    const real = f.deps.executeEffect;
    f.deps.executeEffect = async (input) => {
      const receipt = await real(input);
      f.revoke();
      return receipt;
    };
    expect((await f.client.request(request)).code).toBe("authorization_required");
    expect(real).toHaveBeenCalledTimes(1);
    expect(f.row?.record.status).not.toBe("prepared");
    await expect(
      f.client.bindings({ action: "bindings", operationRef: request.operationRef, selection }),
    ).rejects.toThrow("authorization_required");
  });
  it("stops a fenced worker before effects and preserves the same operation reference", async () => {
    const f = fixture();
    const request = await prepared(f);
    f.approve();
    f.loseFence();
    expect((await f.client.request(request)).code).toBe("operation_in_progress");
    expect(f.deps.executeEffect).not.toHaveBeenCalled();
    expect(f.row?.record.operator?.operationRef).toBe(request.operationRef);
  });
  it("rejects target, session, operation, artifact approval and owner drift", async () => {
    const f = fixture();
    const request = await prepared(f);
    f.approve();
    expect(
      (await f.client.request({ ...request, selection: { ...selection, projectId: "prj_other" } }))
        .code,
    ).toBe("authorization_required");
    expect(
      (await f.client.request({ ...request, selection: { ...selection, sessionId: "other" } }))
        .code,
    ).toBe("authorization_required");
    expect(
      (await f.client.request({ ...request, operationRef: "11111111-1111-4111-8111-111111111111" }))
        .code,
    ).toBe("resource_mismatch");
    expect((await f.client.request({ ...request, planDigest: "c".repeat(64) })).code).toBe(
      "resource_mismatch",
    );
    f.deps.readApproval = async () => ({
      action: "prepare",
      approvalId: "wrong",
      approved: true,
      callId: "different-call",
      planDigest: request.planDigest,
    });
    expect((await f.client.request(request)).code).toBe("authorization_required");
    expect(f.deps.executeEffect).not.toHaveBeenCalled();
  });
  it("preserves old journal shape/identity and refuses silent conversion", async () => {
    const f = fixture();
    const identity = hostedRuntimeIdentity(authority, target);
    f.row = {
      record: {
        approvedByCallId: "legacy",
        kind: "app-runtime",
        privateState: {
          encryptedToken: "old-ciphertext",
          keyVersion: "old-key",
          tokenIv: "iv",
          tokenTag: "tag",
        },
        request: target,
        status: "prepared",
        step: "bound",
        version: 1,
      },
      revision: 1,
    };
    const previous = JSON.stringify(f.row.record);
    expect((await f.client.request({ action: "plan", operation: "prepare", selection })).code).toBe(
      "legacy_runtime_requires_migration",
    );
    expect(JSON.stringify(f.row.record)).toBe(previous);
    expect(hostedRuntimeIdentity(authority, target)).toEqual(identity);
    expect(hostedRuntimeJournalRecordSchema.parse(f.row.record)).not.toHaveProperty("operator");
  });
  it("denies operational client bindings without a resolved owner context", async () => {
    const f = fixture();
    const execution = await prepared(f);
    f.approve();
    await f.client.request(execution);
    const legacyClient = createHostedOperatorClient({
      endpoint: "https://operator.example",
      fetch: async (url, init) =>
        await f.handler(new Request(url instanceof Request ? url.url : url, init)),
      token: async () => "fixture-service-identity",
    });
    await expect(
      legacyClient.bindings({
        action: "bindings",
        operationRef: execution.operationRef,
        selection,
      }),
    ).rejects.toThrow("legacy_runtime_requires_migration");
  });
  it.each([
    { ...environment, NEON_API_KEY: "forbidden" },
    { ...environment, PLATFORM_AUTH_DATABASE_URL: "forbidden-realm-connection" },
    { ...environment, BETTER_AUTH_SECRET: "forbidden-signing-secret" },
    { ...environment, DATABASE_URL: "forbidden-shared-connection" },
    { ...environment, VENDOR_DATABASE_URL: "forbidden-other-app" },
    {
      ...environment,
      SPEND_REVIEW_DATABASE_URL: environment.SPEND_REVIEW_DATABASE_URL.replace(
        "spend_runtime",
        "spend_owner",
      ),
    },
    {
      ...environment,
      SPEND_REVIEW_DATABASE_URL: `${environment.SPEND_REVIEW_DATABASE_URL}&host=other`,
    },
    {
      ...environment,
      SPEND_REVIEW_DATABASE_URL: environment.SPEND_REVIEW_DATABASE_URL.replace(
        plan.neon.endpoint,
        plan.neon.endpoint.replace(".", "-pooler."),
      ),
    },
    { ...environment, PLATFORM_PUBLIC_ORIGIN: "https://other-preview.example.test" },
    { ...environment, PLATFORM_JWKS_URL: "https://other-preview.example.test/_platform/jwks.json" },
  ])("rejects overprivileged or unrelated runtime projection", (env) => {
    expect(() => restrictedOperatorEnvironment(plan, env, authority)).toThrow("resource_mismatch");
  });
  it("adds public expected identities from the approved plan when the private binding reader returns URLs and public origins", () => {
    const withoutBoundary = Object.fromEntries(
      Object.entries(environment).filter(([key]) => key !== "PLATFORM_APP_BOUNDARY"),
    );
    const projected = restrictedOperatorEnvironment(plan, withoutBoundary, authority);
    expect(JSON.parse(projected.PLATFORM_APP_BOUNDARY)).toEqual(appBoundary);
    expect(projected).toEqual(environment);
    expect(projected.PLATFORM_APP_BOUNDARY).not.toContain("synthetic-app");
    expect(projected.PLATFORM_APP_BOUNDARY).not.toContain("migrator");
  });
  it.each([
    { ...appBoundary, appId: "other-app" },
    { ...appBoundary, runtime: { ...appBoundary.runtime, database: "other_database" } },
    { ...appBoundary, runtime: { ...appBoundary.runtime, runtimeRole: "spend_owner" } },
    { ...appBoundary, runtime: { ...appBoundary.runtime, hostname: "other.neon.tech" } },
    { ...appBoundary, runtime: { ...appBoundary.runtime, environment: "local" } },
    {
      ...appBoundary,
      verification: {
        ...appBoundary.verification,
        jwksUrl: "https://other.example/_platform/jwks.json",
      },
    },
    { ...appBoundary, privateKey: "forbidden" },
    { ...appBoundary, version: 2 },
  ])("rejects supplied public boundary facts that do not match the owned plan", (boundary) => {
    expect(() =>
      restrictedOperatorEnvironment(
        plan,
        { ...environment, PLATFORM_APP_BOUNDARY: JSON.stringify(boundary) },
        authority,
      ),
    ).toThrow("resource_mismatch");
  });
  it("does not derive expected runtime identity from a changed credential URL", () => {
    expect(() =>
      restrictedOperatorEnvironment(
        plan,
        {
          ...environment,
          SPEND_REVIEW_DATABASE_URL: environment.SPEND_REVIEW_DATABASE_URL.replace(
            plan.neon.endpoint,
            "other.neon.tech",
          ),
        },
        authority,
      ),
    ).toThrow("resource_mismatch");
    expect(() =>
      restrictedOperatorEnvironment(
        plan,
        {
          ...environment,
          SPEND_REVIEW_DATABASE_URL: environment.SPEND_REVIEW_DATABASE_URL.replace(
            "spend_runtime",
            "other_runtime",
          ),
        },
        authority,
      ),
    ).toThrow("resource_mismatch");
    expect(() =>
      restrictedOperatorEnvironment(
        plan,
        { ...environment, PLATFORM_APP_BOUNDARY: "not-json" },
        authority,
      ),
    ).toThrow("resource_mismatch");
  });
  it("projects only app runtime SQL and public verification configuration", () => {
    expect(restrictedOperatorEnvironment(plan, environment, authority)).toEqual(environment);
    expect(() => restrictedOperatorEnvironment(plan, environment)).toThrow(
      "legacy_runtime_requires_migration",
    );
    expect(() =>
      restrictedOperatorEnvironment(plan, environment, {
        ...authority,
        ownerUserId: "other-owner",
      }),
    ).toThrow("resource_mismatch");
    expect(() =>
      restrictedOperatorEnvironment(plan, environment, {
        ...authority,
        workspaceId: "other-workspace",
      }),
    ).toThrow("resource_mismatch");
  });
  it("parses legacy records for inspection and denies legacy operational projections", () => {
    const legacyPlan = { ...plan };
    delete legacyPlan.deploymentBoundary;
    legacyPlan.publicGateway = {
      branch: selection.branch,
      origin: "https://apps-preview.example.test",
      projectId: selection.projectId,
    };
    expect(hostedOperatorPlanSchema.safeParse(legacyPlan).success).toBe(true);
    expect(() => restrictedOperatorEnvironment(legacyPlan, environment, authority)).toThrow(
      "legacy_runtime_requires_migration",
    );
  });
  it.each(["app", "gateway"] as const)("rejects swapped %s physical project identities", (key) => {
    const boundary = plan.deploymentBoundary;
    if (boundary === undefined) {
      throw new Error("Fixture deployment boundary is absent.");
    }
    expect(
      hostedOperatorPlanSchema.safeParse({
        ...plan,
        deploymentBoundary: {
          ...boundary,
          [key]: { ...boundary[key], projectId: "wrong-project" },
        },
      }).success,
    ).toBe(false);
  });
  it("rejects shared application, Gateway and operator projects", () => {
    const boundary = plan.deploymentBoundary;
    if (boundary === undefined) {
      throw new Error("Fixture deployment boundary is absent.");
    }
    expect(
      hostedOperatorPlanSchema.safeParse({
        ...plan,
        deploymentBoundary: {
          ...boundary,
          operator: { ...boundary.operator, projectId: boundary.app.projectId },
        },
      }).success,
    ).toBe(false);
    expect(
      hostedOperatorPlanSchema.safeParse({
        ...plan,
        deploymentBoundary: {
          ...boundary,
          gateway: { ...boundary.gateway, projectId: boundary.app.projectId },
        },
      }).success,
    ).toBe(false);
  });
  it("rejects sandbox origins and origins swapped across selected Preview targets", () => {
    expect(
      hostedOperatorPlanSchema.safeParse({
        ...plan,
        publicGateway: { ...plan.publicGateway, origin: "https://sandbox.vercel.run" },
      }).success,
    ).toBe(false);
    expect(
      hostedOperatorPlanSchema.safeParse({
        ...plan,
        publicGateway: { ...plan.publicGateway, branch: "another-preview" },
      }).success,
    ).toBe(false);
    expect(
      hostedOperatorPlanSchema.safeParse({
        ...plan,
        publicGateway: { ...plan.publicGateway, projectId: "another-project" },
      }).success,
    ).toBe(false);
  });
  it("uses the same client and handler across a real local HTTP transport boundary", async () => {
    const f = fixture();
    const server = createServer((incoming, outgoing) => {
      void (async () => {
        try {
          const response = await f.handler(
            new Request("http://127.0.0.1/v1/runtime", {
              body: await text(incoming),
              headers: {
                authorization: incoming.headers.authorization ?? "",
                "x-vercel-trusted-oidc-idp-token": String(
                  incoming.headers["x-vercel-trusted-oidc-idp-token"] ?? "",
                ),
              },
              method: "POST",
            }),
          );
          outgoing.writeHead(response.status, Object.fromEntries(response.headers));
          outgoing.end(await response.text());
        } catch {
          outgoing.writeHead(500);
          outgoing.end();
        }
      })();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = server.address();
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Node returns a path for Unix sockets; this fixture listens on a TCP port.
      if (address === null || typeof address === "string") {
        throw new Error("Local server unavailable");
      }
      const client = createHostedOperatorClient({
        allowLoopback: true,
        endpoint: `http://127.0.0.1:${address.port}`,
        ownerContext,
        token: async () => "fixture-service-identity",
      });
      const planned = await client.request({ action: "plan", operation: "prepare", selection });
      f.approve();
      expect(
        (
          await client.request({
            action: "execute",
            callId: "actual-eve-call",
            operationRef: z.uuid().parse(planned.operationRef),
            planDigest: z.string().parse(planned.planDigest),
            selection,
          })
        ).status,
      ).toBe("prepared");
    } finally {
      const closed = once(server, "close");
      server.close();
      await closed;
    }
  });
});

describe("closed operator access response diagnostics", () => {
  it("distinguishes application denial at HTTP200 and correlates ingress without private values", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const f = fixture();
      f.revoke();
      const result = await f.client.request({ action: "plan", operation: "prepare", selection });
      expect(result.code).toBe("authorization_required");
      const sessionIdHash = `sha256:${createHash("sha256").update(selection.sessionId).digest("hex")}`;
      expect(log.mock.calls).toContainEqual([
        "[builder:hosted-neon-consent]",
        expect.objectContaining({
          boundary: "operator",
          outcome: "started",
          sessionIdHash,
          stage: "operator_ingress",
        }),
      ]);
      expect(log.mock.calls).toContainEqual([
        "[builder:hosted-neon-consent]",
        expect.objectContaining({
          accessClass: "application_auth_denied",
          boundary: "builder",
          httpStatus: 200,
          sessionIdHash,
          stage: "operator_request",
        }),
      ]);
      const output = JSON.stringify(log.mock.calls);
      for (const privateValue of [
        selection.sessionId,
        "fixture-service-identity",
        authority.ownerUserId,
        authority.workspaceId,
        "https://operator.example",
      ]) {
        expect(output).not.toContain(privateValue);
      }
      expect(f.row).toBeUndefined();
    } finally {
      log.mockRestore();
    }
  });
  it.each([401, 403])(
    "preserves HTTP%s transport denial without reading a private body",
    async (status) => {
      const secret = "private-body header-token owner-id";
      const response = Response.json(
        { error: { code: secret }, token: secret },
        {
          headers: {
            "x-vercel-error": status === 403 ? "TRUSTED_SOURCES_ENVIRONMENT_MISMATCH" : secret,
          },
          status,
        },
      );
      const body = vi.spyOn(response, "json");
      const token = vi.fn(async () => secret);
      const fetchResponse = vi.fn<typeof fetch>(async (_url, init) => {
        const headers = new Headers(init?.headers);
        expect(headers.get("x-vercel-trusted-oidc-idp-token")).toBe(secret);
        if (init?.method === "GET") {
          expect(init.body).toBeUndefined();
          expect(init.redirect).toBe("error");
          return new Response('{"code":"not_found"}', { status: 404 });
        }
        expect(init?.method).toBe("POST");
        expect(headers.get("authorization")).toBe(`Bearer ${secret}`);
        return response;
      });
      const log = vi.spyOn(console, "info").mockImplementation(() => {});
      try {
        const client = createHostedOperatorClient({
          endpoint: "https://operator.example",
          fetch: fetchResponse,
          ownerContext,
          token,
        });
        await expect(
          client.request({ action: "plan", operation: "prepare", selection }),
        ).rejects.toMatchObject({ code: "authorization_required" });
        expect(body).not.toHaveBeenCalled();
        expect(token).toHaveBeenCalledOnce();
        expect(fetchResponse).toHaveBeenCalledTimes(status === 403 ? 3 : 1);
        expect(fetchResponse.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(
          1,
        );
        const responseDiagnostics = log.mock.calls.flatMap(([, value]) => {
          const parsed = z
            .object({
              boundary: z.literal("builder"),
              stage: z.literal("operator_request"),
              operatorAction: z.literal("plan"),
              accessClass: z.literal("upstream_auth_denied"),
              outcome: z.literal("operator_access_denied"),
              httpStatus: z.literal(status),
              sessionIdHash: z.string(),
              vercelError: z.literal("TRUSTED_SOURCES_ENVIRONMENT_MISMATCH").optional(),
            })
            .safeParse(value);
          return parsed.success ? [parsed.data] : [];
        });
        expect(responseDiagnostics).toHaveLength(1);
        const [responseDiagnostic] = responseDiagnostics;
        expect(responseDiagnostic).toMatchObject({
          accessClass: "upstream_auth_denied",
          httpStatus: status,
          sessionIdHash: `sha256:${createHash("sha256").update(selection.sessionId).digest("hex")}`,
        });
        expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
        if (status === 401) {
          expect(responseDiagnostic).not.toHaveProperty("vercelError");
        } else {
          expect(responseDiagnostic).toHaveProperty(
            "vercelError",
            "TRUSTED_SOURCES_ENVIRONMENT_MISMATCH",
          );
        }
      } finally {
        log.mockRestore();
      }
    },
  );
  it.each([200, 503])(
    "reports HTTP%s without changing its existing public result",
    async (status) => {
      const log = vi.spyOn(console, "info").mockImplementation(() => {});
      try {
        const client = createHostedOperatorClient({
          endpoint: "https://operator.example",
          fetch: async () =>
            Response.json(
              { appId: selection.appId, authenticatedBehavior: "unassessed", status: "pending" },
              { status },
            ),
          token: async () => "secret",
        });
        const result = client.request({ action: "plan", operation: "prepare", selection });
        await (status === 200
          ? expect(result).resolves.toMatchObject({ status: "pending" })
          : expect(result).rejects.toMatchObject({ code: "operator_unavailable" }));
        expect(log.mock.calls).toContainEqual([
          "[builder:hosted-neon-consent]",
          expect.objectContaining({
            boundary: "builder",
            stage: "operator_request",
            operatorAction: "plan",
            outcome: status === 200 ? "verified" : "setup_unavailable",
            accessClass: status === 200 ? "ok" : "other_failed",
            httpStatus: status,
          }),
        ]);
      } finally {
        log.mockRestore();
      }
    },
  );
});

describe("native bindings integration", () => {
  it("projects only pinned deliveries after fresh verification through service and client", async () => {
    const f = fixture();
    const selectedPlan = hostedOperatorPlanSchema.parse({
      ...plan,
      delivery: { branch: selection.branch, projectId: selection.projectId, repoId: "repo-app" },
      effects: [
        ...plan.effects,
        { description: "Native app delivery", id: "delivery", kind: "delivery" },
        {
          description: "Native Gateway delivery",
          id: "gateway-delivery",
          kind: "gateway-delivery",
        },
      ],
      gatewayDelivery: {
        branch: selection.branch,
        projectId: "prj_gateway",
        repoId: "repo-gateway",
      },
    });
    const request = await prepared(f);
    f.approve();
    await f.client.request(request);
    if (!f.row?.record.operator) {
      throw new Error("Missing fixture journal");
    }
    f.row.record.operator.plan = selectedPlan;
    f.row.record.operator.planDigest = operatorPlanDigest(selectedPlan);
    const metadata = {
      app: {
        branch: selection.branch,
        deploymentId: "dpl_actual_app",
        operationRef: request.operationRef,
        origin: "https://immutable-app.example.test",
        projectId: selection.projectId,
        readyState: "READY",
        repoId: "repo-app",
      },
      gateway: {
        branch: selection.branch,
        deploymentId: "dpl_actual_gateway",
        operationRef: request.operationRef,
        origin: "https://immutable-gateway.example.test",
        projectId: "prj_gateway",
        readyState: "READY",
        repoId: "repo-gateway",
      },
      publicOrigin: "https://apps-preview.example.test",
    };
    f.row.record.operator.deliveryCandidates = [metadata.app];
    f.row.record.operator.gatewayDeliveryCandidates = [metadata.gateway];
    f.row.record.operator.deliveredDeploymentId = metadata.app.deploymentId;
    f.row.record.operator.deliveredGatewayDeploymentId = metadata.gateway.deploymentId;
    const result = await f.client.bindings({
      action: "bindings",
      operationRef: request.operationRef,
      selection,
    });
    expect(result.nativePreview).toMatchObject({
      app: metadata.app,
      gateway: metadata.gateway,
      planDigest: operatorPlanDigest(selectedPlan),
      publicOrigin: metadata.publicOrigin,
    });
    const replacement = {
      ...metadata.gateway,
      deploymentId: "dpl_replacement_gateway",
      origin: "https://replacement-gateway.example.test",
    };
    f.row.record.operator.gatewayDeliveryCandidates.push(replacement);
    f.row.record.operator.deliveredGatewayDeploymentId = replacement.deploymentId;
    f.row.revision += 1;
    const refreshed = await f.client.bindings({
      action: "bindings",
      operationRef: request.operationRef,
      selection,
    });
    expect(refreshed.nativePreview?.gateway).toEqual(replacement);
  });
});

describe("idle installer source successor planning", () => {
  it("retains custody and prior approval while requiring new approval and reconciling the refreshed worker first", async () => {
    const now = Date.parse("2026-10-20T12:00:00Z");
    const f = fixture(() => now);
    const requireRow = () => {
      const row = f.row;
      if (row === undefined) {
        throw new Error("Missing source successor fixture journal");
      }
      return row;
    };
    const program = {
      version: 1 as const,
      appId: selection.appId,
      origin: "https://apps-preview.example.test",
      actors: [
        {
          actorKey: "owner",
          account: "capture-existing" as const,
          email: "owner@example.test",
          name: "Owner",
        },
      ],
      organizations: [],
      memberships: [],
      appAccess: [],
    };
    const preparation = {
      accountOperationRef: "facfd14d-e963-4228-8219-dba37c95b0b8",
      accountPlanDigest: operatorPlanDigest(plan),
      accountApprovalId: "original-account-approval",
      accountApprovedByCallId: "original-account-call",
      programDigest: normalActorProgramDigest(program),
    };
    const oldPlan = hostedOperatorPlanSchema.parse({
      ...plan,
      stage: "app",
      access: [],
      normalActorProgram: program,
      normalActorPreparation: preparation,
      effects: [
        {
          id: "auth-resources",
          kind: "resources",
          description: "Observe Auth",
        },
        {
          id: "app-resources",
          kind: "resources",
          description: "Observe app",
        },
        {
          id: "auth-schema",
          kind: "install",
          description: "Observe Auth schema",
        },
        ...plan.effects.slice(1),
      ],
    });
    f.deps.plan = async () => oldPlan;
    const originalRequest = await prepared(f);
    const current = requireRow();
    const privateState = {
      encryptedToken: "ciphertext",
      keyVersion: "key-v1",
      tokenIv: "iv",
      tokenTag: "tag",
    };
    const accountPreparation = {
      ...preparation,
      program,
      accountPlan: plan,
      sealedState: {
        encryptedToken: "sealed-account-state",
        keyVersion: "v1",
        tokenIv: "iv",
        tokenTag: "tag",
      },
      captures: [],
    };
    f.row = {
      ...current,
      record: hostedRuntimeJournalRecordSchema.parse({
        ...current.record,
        privateState,
        accountPreparation,
      }),
    };
    f.approve();
    let originalApproved = true;
    let newApproved = false;
    const readApproval = f.deps.readApproval;
    f.deps.readApproval = vi.fn<ProtectedHostedOperatorDependencies["readApproval"]>(
      async (input) => {
        if (
          (input.callId === originalRequest.callId && !originalApproved) ||
          (input.callId === "new-source-call" && !newApproved)
        ) {
          return null;
        }
        return await readApproval(input);
      },
    );
    const observedReceipt = (effectId: string, fenceGeneration: number) => ({
      effectId,
      fenceGeneration,
      observedAt: new Date(now).toISOString(),
      resourceVersion: "observed-prerequisite",
    });
    f.deps.reconcile = vi.fn<ProtectedHostedOperatorDependencies["reconcile"]>(async (input) => {
      if (input.effect.id === "install") {
        throw new HostedOperatorError("resource_mismatch");
      }
      return {
        status: "applied" as const,
        receipt: observedReceipt(input.effect.id, input.fenceGeneration),
      };
    });
    expect(await f.client.request(originalRequest)).toMatchObject({
      status: "blocked",
      code: "resource_mismatch",
    });
    const failed = structuredClone(requireRow());
    expect(failed.record).toMatchObject({
      privateState,
      accountPreparation,
      executionObservation: {
        state: "settled",
        operationRef: originalRequest.operationRef,
        planDigest: originalRequest.planDigest,
        callId: originalRequest.callId,
        approvalId: "durable-human-decision",
        outcome: { status: "blocked", code: "resource_mismatch" },
      },
    });
    expect(failed.record.leaseId).toBeUndefined();
    expect(failed.record.leaseExpiresAt).toBeUndefined();
    expect(failed.record.operator?.pendingEffectId).toBeUndefined();
    expect(failed.record.operator?.pendingEffectAttempt).toBeUndefined();
    expect(failed.record.operator?.receipts.map((receipt) => receipt.effectId)).toEqual([
      "auth-resources",
      "app-resources",
      "auth-schema",
    ]);
    expect(f.deps.executeEffect).not.toHaveBeenCalled();
    f.deps.plan = async () => {
      const successor = createInstallerSourceSuccessorPlan(
        requireRow().record,
        { id: oldPlan.installer.reference, sha256: "e".repeat(64) },
        now,
      );
      if (successor === undefined) {
        throw new Error("Expected eligible idle source successor");
      }
      return successor;
    };
    originalApproved = false;
    expect(
      await f.client.request({ action: "plan", operation: "prepare", selection }),
    ).toMatchObject({ status: "blocked", code: "authorization_required" });
    expect(f.row).toEqual(failed);
    originalApproved = true;
    const proposed = await f.client.request({ action: "plan", operation: "prepare", selection });
    expect(proposed).toMatchObject({
      status: "planned",
      operationRef: originalRequest.operationRef,
    });
    const proposedPlan = hostedOperatorPlanSchema.parse(proposed.plan);
    expect(proposedPlan).toEqual({
      ...oldPlan,
      installer: { ...oldPlan.installer, sha256: "e".repeat(64) },
    });
    expect(requireRow().record).toMatchObject({
      privateState,
      accountPreparation,
      approvedByCallId: "operator:unapproved-plan",
    });
    expect(requireRow().record.operator?.approvalId).toBeUndefined();
    expect(requireRow().record.operator?.fenceGeneration).toBe(
      failed.record.operator?.fenceGeneration,
    );
    expect(requireRow().record.operator?.receipts).toEqual(failed.record.operator?.receipts);
    expect(requireRow().record.operator?.retainedInstallerOperations).toEqual([
      { approvedByCallId: originalRequest.callId, operator: failed.record.operator },
    ]);
    expect(f.deps.executeEffect).not.toHaveBeenCalled();
    const request = {
      ...originalRequest,
      callId: "new-source-call",
      planDigest: z.string().parse(proposed.planDigest),
    };
    const reconcile = vi.fn<ProtectedHostedOperatorDependencies["reconcile"]>(async () => ({
      status: "unknown",
    }));
    f.deps.reconcile = reconcile;
    expect(await f.client.request(request)).toMatchObject({
      status: "blocked",
      code: "authorization_required",
    });
    expect(reconcile).not.toHaveBeenCalled();
    newApproved = true;
    expect(await f.client.request(request)).toMatchObject({
      status: "blocked",
      code: "reconciliation_required",
    });
    expect(reconcile).toHaveBeenCalledWith(
      expect.objectContaining({
        effect: proposedPlan.effects.find((effect) => effect.id === "install"),
        plan: proposedPlan,
        privateState,
      }),
    );
    expect(f.deps.executeEffect).not.toHaveBeenCalled();
    expect(requireRow().record.accountPreparation).toEqual(accountPreparation);
    f.deps.reconcile = vi.fn<ProtectedHostedOperatorDependencies["reconcile"]>(async (input) =>
      input.effect.id === "install"
        ? { status: "absent" as const }
        : { status: "unknown" as const },
    );
    expect(await f.client.request(request)).toMatchObject({
      status: "blocked",
      code: "reconciliation_required",
    });
    expect(f.deps.executeEffect).toHaveBeenCalledTimes(1);
    expect(f.deps.executeEffect).toHaveBeenCalledWith(
      expect.objectContaining({
        effect: proposedPlan.effects.find((effect) => effect.id === "install"),
        plan: proposedPlan,
        privateState,
      }),
    );
    expect(requireRow().record.privateState).toEqual(privateState);
    expect(requireRow().record.accountPreparation).toEqual(accountPreparation);
    expect(requireRow().record.operator?.receipts.map((receipt) => receipt.effectId)).toEqual([
      "auth-resources",
      "app-resources",
      "auth-schema",
      "install",
    ]);
  });
});

describe("approved retention renewal planning", () => {
  it.each(["bindings", "gateway-bindings", "gateway-delivery"] as const)(
    "saves and re-exposes pending %s without recomposing or inheriting execution authority",
    async (pendingKind) => {
      const now = Date.parse("2026-10-18T00:00:00Z");
      const f = fixture(() => now);
      const oldPlan = hostedOperatorPlanSchema.parse({
        ...plan,
        delivery: {
          branch: selection.branch,
          gitSha: "c".repeat(40),
          projectId: selection.projectId,
          repoId: "repo-app",
        },
        effects: [
          ...plan.effects,
          { description: "Native app delivery", id: "delivery", kind: "delivery" },
          { description: "Gateway bindings", id: "gateway-bindings", kind: "gateway-bindings" },
          {
            description: "Native Gateway delivery",
            id: "gateway-delivery",
            kind: "gateway-delivery",
          },
        ],
        gatewayBindings: {
          authBrowserOrigin: "https://auth-preview.example.test",
          builderCallbackOrigin: "https://builder.example.test",
          catalogAppIds: [selection.appId],
          operatorOrigin: "https://operator.example.test",
          sourceWorkload: {
            audience: "https://vercel.com/team_fixture",
            environment: "preview",
            issuer: "https://oidc.vercel.com/team_fixture",
            ownerId: "team_fixture",
            projectId: "prj_gateway",
            subject: "gateway-workload",
          },
        },
        gatewayDelivery: {
          branch: selection.branch,
          gitSha: "d".repeat(40),
          projectId: "prj_gateway",
          repoId: "repo-gateway",
        },
        retention: { ...plan.retention, expiresAt: "2026-10-17T00:00:00Z" },
        stage: "app",
      });
      const operationRef = "a5c2b20f-0c08-49a8-a34f-cce64c72cc8c";
      const pendingEffect = oldPlan.effects.find((effect) => effect.kind === pendingKind);
      if (pendingEffect === undefined) {
        throw new Error("Expected the selected renewal effect in the fixture plan");
      }
      const pendingEffectId = pendingEffect.id;
      const pendingIndex = oldPlan.effects.findIndex((effect) => effect.id === pendingEffectId);
      const oldReceipts = oldPlan.effects.slice(0, pendingIndex).map((effect) => ({
        effectId: effect.id,
        observedAt: "2026-10-16T00:00:00.000Z",
        resourceVersion: "a".repeat(64),
      }));
      f.row = {
        record: hostedRuntimeJournalRecordSchema.parse({
          approvedByCallId: "original-approved-call",
          kind: "app-runtime",
          operator: {
            approvalId: "durable-human-decision",
            mode: "protected-operator-v1",
            operationRef,
            plan: oldPlan,
            planDigest: operatorPlanDigest(oldPlan),
            receipts: oldReceipts,
            pendingEffectId,
            pendingEffectAttempt: {
              id: "0b0e9c7b-b48f-4f8d-99be-9b74c9606799",
              contextDigest: "e".repeat(64),
            },
          },
          privateState: {
            encryptedToken: "ciphertext",
            keyVersion: "key-v1",
            tokenIv: "iv",
            tokenTag: "tag",
          },
          request: target,
          status: "pending",
          step: "reserved",
          version: 1,
        }),
        revision: 10,
      };
      f.approve();
      f.deps.plan = vi.fn(async () => {
        throw new Error("renewal should not recompose the approved source plan");
      });

      const first = await f.client.request({ action: "plan", operation: "prepare", selection });
      expect(first).toMatchObject({ status: "planned", operationRef });
      const firstPlan = first.plan;
      if (firstPlan === undefined) {
        throw new Error("The retention renewal response must include its frozen plan");
      }
      expect(Date.parse(firstPlan.retention.expiresAt)).toBe(now + 24 * 60 * 60 * 1000);
      expect(firstPlan.appTrustedSources?.gatewayPreview).toEqual({
        from: "preview",
        projectId: "prj_gateway",
        to: "preview",
      });
      expect(firstPlan.gatewayBindings?.trustedSources?.appPreview).toEqual({
        from: "preview",
        projectId: selection.projectId,
        to: "preview",
      });
      expect(f.deps.plan).not.toHaveBeenCalled();

      const renewed = f.row?.record.operator;
      expect(renewed).toMatchObject({
        operationRef,
        planDigest: first.planDigest,
        receipts: oldReceipts.filter((receipt) =>
          ["resources", "install"].includes(receipt.effectId),
        ),
      });
      expect(f.row?.record.approvedByCallId).toBe("operator:unapproved-plan");
      expect(renewed?.approvalId).toBeUndefined();
      expect(renewed?.pendingEffectId).toBeUndefined();
      expect(renewed?.pendingEffectAttempt).toBeUndefined();
      expect(renewed?.fenceGeneration).toBeUndefined();
      expect(renewed?.retainedRenewalOperations?.[0]).toMatchObject({
        approvedByCallId: "original-approved-call",
        operator: {
          approvalId: "durable-human-decision",
          pendingEffectId,
          pendingEffectAttempt: {
            id: "0b0e9c7b-b48f-4f8d-99be-9b74c9606799",
            contextDigest: "e".repeat(64),
          },
          planDigest: operatorPlanDigest(oldPlan),
          receipts: oldReceipts,
        },
      });

      const repeated = await f.client.request({ action: "plan", operation: "prepare", selection });
      expect(repeated.plan).toEqual(first.plan);
      expect(repeated.planDigest).toBe(first.planDigest);
      expect(f.deps.plan).not.toHaveBeenCalled();

      const privateError = new TypeError("private authorization detail owner-token");
      const assertAuthorized = f.deps.assertAuthorized;
      const log = vi.spyOn(console, "info").mockImplementation(() => {});
      try {
        f.deps.assertAuthorized = vi.fn(async () => {
          throw privateError;
        });
        expect(
          await f.client.request({ action: "plan", operation: "prepare", selection }),
        ).toMatchObject({ status: "blocked", code: "operator_unavailable" });
        expect(log.mock.calls).toContainEqual([
          "[builder:hosted-neon-consent]",
          expect.objectContaining({
            planningFailure: { stage: "saved_plan_reexposure", errorClass: "type_error" },
          }),
        ]);
        expect(JSON.stringify(log.mock.calls)).not.toContain(privateError.message);
      } finally {
        log.mockRestore();
        f.deps.assertAuthorized = assertAuthorized;
      }
      if (pendingKind !== "gateway-delivery") {
        const readApproval = f.deps.readApproval;
        const approvalRead = vi.fn<ProtectedHostedOperatorDependencies["readApproval"]>(
          async (input) => (input.callId === "renewed-call" ? null : await readApproval(input)),
        );
        f.deps.readApproval = approvalRead;
        const execute = {
          action: "execute" as const,
          callId: "renewed-call",
          operationRef,
          planDigest: operatorPlanDigest(firstPlan),
          selection,
        };
        expect(await f.client.request(execute)).toMatchObject({
          status: "blocked",
          code: "authorization_required",
        });
        expect(f.deps.executeEffect).not.toHaveBeenCalled();
        const blockedReconcile = vi.fn<ProtectedHostedOperatorDependencies["reconcile"]>(
          async () => ({ status: "unknown" }),
        );
        f.deps.reconcile = blockedReconcile;
        approvalRead.mockImplementation(async (input) =>
          input.callId === "original-approved-call" ? null : await readApproval(input),
        );
        expect(await f.client.request(execute)).toMatchObject({
          status: "blocked",
          code: "authorization_required",
        });
        expect(blockedReconcile).not.toHaveBeenCalled();
        expect(f.deps.executeEffect).not.toHaveBeenCalled();
        approvalRead.mockImplementation(readApproval);
        const reconcile = vi.fn<ProtectedHostedOperatorDependencies["reconcile"]>(async (input) => {
          if (input.effect.id === pendingEffectId) {
            expect(input.renewalBindingProvenance).toMatchObject({
              approvedByCallId: "original-approved-call",
              approvalId: "durable-human-decision",
              effectId: pendingEffectId,
              kind: pendingKind,
              operationRef,
              pendingEffectAttempt: {
                id: "0b0e9c7b-b48f-4f8d-99be-9b74c9606799",
                contextDigest: "e".repeat(64),
              },
              planDigest: operatorPlanDigest(oldPlan),
            });
            return { status: "unknown" };
          }
          return {
            status: "applied",
            receipt: {
              effectId: input.effect.id,
              fenceGeneration: input.fenceGeneration,
              observedAt: new Date(now).toISOString(),
              resourceVersion: "observed-prerequisite",
            },
          };
        });
        f.deps.reconcile = reconcile;
        expect(await f.client.request(execute)).toMatchObject({
          status: "blocked",
          code: "reconciliation_required",
        });
        expect(reconcile.mock.calls.some(([input]) => input.effect.id === pendingEffectId)).toBe(
          true,
        );
        expect(approvalRead).toHaveBeenCalledWith(
          expect.objectContaining({
            callId: "original-approved-call",
            planDigest: operatorPlanDigest(oldPlan),
          }),
        );
        expect(f.deps.executeEffect).not.toHaveBeenCalled();
      }
    },
  );
});

describe("read-only configured Preview target resolution", () => {
  const resolveRequest = () =>
    new Request("https://operator.example/v1/runtime", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "resolve-preview-target",
        appId: selection.appId,
        sessionId: selection.sessionId,
        ownerContext,
      }),
    });
  it("returns only the authorized nonsecret selection without journal or effect calls", async () => {
    const f = fixture();
    f.deps.resolvePreviewTarget = vi.fn(async () => ({ authority, ownerContext, target }));
    const planCall = vi.spyOn(f.deps, "plan");
    const journalRead = vi.spyOn(f.deps.store, "read");
    const effectCall = vi.spyOn(f.deps, "executeEffect");
    const result = await createProtectedHostedOperatorHandler(f.deps)(resolveRequest());
    expect(await result.json()).toEqual(selection);
    expect(planCall).not.toHaveBeenCalled();
    expect(journalRead).not.toHaveBeenCalled();
    expect(effectCall).not.toHaveBeenCalled();
    expect(f.row).toBeUndefined();
  });
  it("fails only a resolver request when the adapter does not implement metadata resolution", async () => {
    const f = fixture();
    const result = await createProtectedHostedOperatorHandler(f.deps)(resolveRequest());
    expect(await result.json()).toMatchObject({
      appId: selection.appId,
      status: "blocked",
      code: "protected_operator_required",
    });
  });
  it.each(["appId", "sessionId"] as const)(
    "does not disclose a result for another %s",
    async (field) => {
      const f = fixture();
      f.deps.resolvePreviewTarget = async () => ({
        authority,
        target: { ...target, [field]: "other" },
      });
      const result = await createProtectedHostedOperatorHandler(f.deps)(resolveRequest());
      expect(await result.json()).toMatchObject({
        status: "blocked",
        code: "authorization_required",
      });
    },
  );
  it("does not disclose a Production target", async () => {
    const f = fixture();
    const invalidTarget = { ...target };
    Object.defineProperty(invalidTarget, "environment", { value: "production" });
    f.deps.resolvePreviewTarget = async () => ({ authority, target: invalidTarget });
    const result = await createProtectedHostedOperatorHandler(f.deps)(resolveRequest());
    expect(await result.json()).toMatchObject({ status: "blocked" });
  });
  it("preserves authorization denial and creates no journal", async () => {
    const f = fixture();
    f.deps.resolvePreviewTarget = async () => {
      throw new HostedOperatorError("authorization_required");
    };
    const result = await createProtectedHostedOperatorHandler(f.deps)(resolveRequest());
    expect(await result.json()).toMatchObject({
      status: "blocked",
      code: "authorization_required",
    });
    expect(f.row).toBeUndefined();
  });
});

const observationFixture = () => {
  const f = fixture();
  let currentTime = Date.parse("2026-10-14T16:45:00.000Z");
  let providerAuthorizationReads = 0;
  let canonicalOwnerReads = 0;
  let durableApprovalReads = 0;
  let physicalFenceReads = 0;
  let approvalId = "durable-human-decision";
  const fullAuthorization = f.deps.assertAuthorized;
  const { readApproval } = f.deps;
  const { withResourceLease } = f.deps;
  f.deps.now = () => currentTime;
  f.deps.assertAuthorized = async (input) => {
    // This existing adapter represents the provider-backed full authorization path.
    providerAuthorizationReads += 1;
    await fullAuthorization(input);
  };
  f.deps.assertCanonicalOwner = async (input) => {
    canonicalOwnerReads += 1;
    await fullAuthorization({ ...input, plan });
  };
  f.deps.readApproval = async (input) => {
    durableApprovalReads += 1;
    const approval = await readApproval(input);
    return approval === null ? null : { ...approval, approvalId };
  };
  const readLeaseFence = async (
    input: Parameters<ProtectedHostedOperatorDependencies["withResourceLease"]>[0],
  ) => {
    const row = await f.deps.store.read(input);
    const record = row?.record;
    const operator = record?.operator;
    const hasLiveLease =
      record?.leaseId !== undefined &&
      record.leaseExpiresAt !== undefined &&
      Date.parse(record.leaseExpiresAt) > currentTime;
    const hasCurrentFence =
      operator?.operationRef === input.operationRef && operator.fenceGeneration !== undefined;
    const hasCurrentPlan = operator?.planDigest === operatorPlanDigest(input.plan);
    if (!hasLiveLease || !hasCurrentFence || !hasCurrentPlan) {
      throw new HostedOperatorError("operation_in_progress");
    }
    return { leaseId: record.leaseId, fenceGeneration: operator.fenceGeneration };
  };
  f.deps.withResourceLease = async (input, run) => {
    const initialFence = await readLeaseFence(input);
    return await withResourceLease(
      input,
      async (assertFence) =>
        await run(async () => {
          physicalFenceReads += 1;
          const currentFence = await readLeaseFence(input);
          if (
            currentFence.leaseId !== initialFence.leaseId ||
            currentFence.fenceGeneration !== initialFence.fenceGeneration
          ) {
            throw new HostedOperatorError("operation_in_progress");
          }
          await assertFence();
        }),
    );
  };
  const handler = createProtectedHostedOperatorHandler(f.deps);
  const client = createHostedOperatorClient({
    endpoint: "https://operator.example",
    fetch: async (url, init) =>
      await handler(new Request(url instanceof Request ? url.url : url, init)),
    ownerContext,
    token: async () => "fixture-service-identity",
  });
  return {
    ...f,
    client,
    base: f,
    counters: () => ({
      providerAuthorizationReads,
      canonicalOwnerReads,
      durableApprovalReads,
      physicalFenceReads,
    }),
    changeApproval: () => {
      approvalId = "different-durable-human-decision";
    },
    advance: (duration: number) => {
      currentTime += duration;
    },
  };
};

describe("private observation within the approved operator effect", () => {
  it("rechecks canonical owner, durable approval, physical fence and actual lease without adding provider authorization reads", async () => {
    const f = observationFixture();
    const request = await prepared(f);
    f.approve();
    const original = f.deps.executeEffect;
    let observations = 0;
    f.deps.executeEffect = async (input) => {
      const before = f.counters();
      const revision = f.base.row?.revision;
      const leaseExpiresAt = f.base.row?.record.leaseExpiresAt;
      if (input.assertCurrentObservation === undefined) {
        throw new Error("Missing observation guard");
      }
      await input.assertCurrentObservation();
      const after = f.counters();
      expect(after.providerAuthorizationReads).toBe(before.providerAuthorizationReads);
      expect(after.canonicalOwnerReads).toBe(before.canonicalOwnerReads + 1);
      expect(after.durableApprovalReads).toBe(before.durableApprovalReads + 1);
      expect(after.physicalFenceReads).toBe(before.physicalFenceReads + 1);
      expect(f.base.row?.revision).toBe(revision);
      expect(f.base.row?.record.leaseExpiresAt).toBe(leaseExpiresAt);
      observations += 1;
      return await original(input);
    };
    expect((await f.client.request(request)).status).toBe("prepared");
    expect(observations).toBeGreaterThan(0);
    // Ordinary outer lifecycle/full mutation guards still perform provider checks.
    expect(f.counters().providerAuthorizationReads).toBeGreaterThan(0);
  });
  it.each([
    ["owner revoked", "authorization_required"],
    ["approval replaced", "authorization_required"],
    ["execution lease expired", "operation_in_progress"],
    ["physical fence lost", "operation_in_progress"],
    ["frozen plan expired", "authorization_required"],
  ])("rejects %s before permitting private observation", async (failure, expectedCode) => {
    const f = observationFixture();
    const request = await prepared(f);
    f.approve();
    let observed = false;
    f.deps.executeEffect = async (input) => {
      switch (failure) {
        case "owner revoked": {
          f.revoke();
          break;
        }
        case "approval replaced": {
          f.changeApproval();
          break;
        }
        case "execution lease expired": {
          f.advance(60_001);
          break;
        }
        case "physical fence lost": {
          f.loseFence();
          break;
        }
        case "frozen plan expired": {
          f.advance(366 * 24 * 60 * 60 * 1000);
          break;
        }
        default: {
          throw new Error("Unknown observation failure");
        }
      }
      const before = f.counters().providerAuthorizationReads;
      if (input.assertCurrentObservation === undefined) {
        throw new Error("Missing observation guard");
      }
      try {
        await input.assertCurrentObservation();
        observed = true;
      } finally {
        expect(f.counters().providerAuthorizationReads).toBe(before);
      }
      return {
        effectId: input.effect.id,
        fenceGeneration: input.fenceGeneration,
        observedAt: new Date().toISOString(),
        resourceVersion: "unreachable",
      };
    };
    expect((await f.client.request(request)).code).toBe(expectedCode);
    expect(observed).toBe(false);
  });
});

describe("closed prepare pre-effect diagnostics", () => {
  it.each([
    "owner_authorization",
    "journal_read",
    "provider_authorization",
    "approval_authorization",
    "approval_read",
    "lease_claim",
  ] as const)("reports %s without changing public errors or entering effects", async (stage) => {
    const f = fixture();
    const request = await prepared(f);
    f.approve();
    const before = structuredClone(f.row);
    const privateError = new TypeError("private-sdk-request private-token private-user-id");
    const fail = async () => {
      throw privateError;
    };
    switch (stage) {
      case "owner_authorization": {
        f.deps.authorize = fail;
        break;
      }
      case "journal_read": {
        f.deps.store.read = fail;
        break;
      }
      case "provider_authorization": {
        f.deps.assertAuthorized = fail;
        break;
      }
      case "approval_authorization": {
        f.deps.assertAuthorized = vi
          .fn<ProtectedHostedOperatorDependencies["assertAuthorized"]>()
          .mockImplementationOnce(async () => {})
          .mockRejectedValue(privateError);
        break;
      }
      case "approval_read": {
        f.deps.readApproval = fail;
        break;
      }
      case "lease_claim": {
        f.deps.store.compareAndSet = fail;
        break;
      }
      default: {
        throw new Error("Unexpected closed execution stage");
      }
    }
    const lease = vi.spyOn(f.deps, "withResourceLease");
    const approval = vi.spyOn(f.deps, "readApproval");
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      expect(await f.client.request(request)).toMatchObject({
        status: "blocked",
        code: "operator_unavailable",
      });
      expect(log.mock.calls).toContainEqual([
        "[builder:hosted-neon-consent]",
        expect.objectContaining({
          boundary: "operator",
          stage: "operator_request",
          executionFailure: { stage, errorClass: "type_error" },
        }),
      ]);
      expect(JSON.stringify(log.mock.calls)).not.toContain("planningFailure");
      const output = JSON.stringify(log.mock.calls);
      for (const privateValue of [
        privateError.message,
        "private-token",
        "private-user-id",
        selection.sessionId,
        request.callId,
        request.operationRef,
        request.planDigest,
      ]) {
        expect(output).not.toContain(privateValue);
      }
      expect(f.row).toEqual(before);
      expect(lease).not.toHaveBeenCalled();
      expect(f.deps.executeEffect).not.toHaveBeenCalled();
      if (
        [
          "owner_authorization",
          "journal_read",
          "provider_authorization",
          "approval_authorization",
        ].includes(stage)
      ) {
        expect(approval).not.toHaveBeenCalled();
      }
    } finally {
      log.mockRestore();
    }
  });

  it("retains authoritative approval validation and its original denial", async () => {
    const f = fixture();
    const request = await prepared(f);
    const before = structuredClone(f.row);
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      expect(await f.client.request(request)).toMatchObject({ code: "authorization_required" });
      expect(log.mock.calls).toContainEqual([
        "[builder:hosted-neon-consent]",
        expect.objectContaining({
          executionFailure: {
            stage: "approval_read",
            errorClass: "operator_error",
            code: "authorization_required",
          },
        }),
      ]);
      expect(f.row).toEqual(before);
      expect(f.deps.executeEffect).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it("preserves the exact thrown SDK error and ignores diagnostic sink failures", async () => {
    const privateError = Object.assign(new Error("private-sdk-request private-token"), {
      code: "42501",
    });
    const sink = vi.fn<HostedOperatorConsentDiagnosticSink>(() => {
      throw new Error("private-sink-failure");
    });
    await expect(
      observeOperatorExecutionStage(
        selection.sessionId,
        "approval_read",
        () => {
          throw privateError;
        },
        sink,
      ),
    ).rejects.toBe(privateError);
    expect(sink).toHaveBeenCalledWith(
      expect.objectContaining({
        executionFailure: { stage: "approval_read", errorClass: "unexpected", sqlState: "42501" },
      }),
    );
    expect(JSON.stringify(sink.mock.calls)).not.toContain(privateError.message);
  });
});

describe("canonical runtime proof through the production verifier and handler", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  it.each(["ready", "release_mismatch", "manifest_mismatch", "authority_denied"] as const)(
    "accepts actual rich readiness after preserving %s behavior without effect replay",
    async (initialScenario) => {
      let scenario = initialScenario;
      const f = fixture();
      const artifactHash = "c".repeat(64);
      const manifest = Buffer.from(
        JSON.stringify({
          app: selection.appId,
          hashes: { schema: `sha256:${artifactHash}` },
          schema_version: plan.release.id,
        }),
      );
      const selectedPlan = hostedOperatorPlanSchema.parse({
        ...plan,
        deploymentBoundary: {
          ...plan.deploymentBoundary,
          operator: { ...plan.deploymentBoundary?.operator, environment: "preview" },
        },
        neon: { ...plan.neon, branchId: "br-fixture" },
        delivery: { branch: selection.branch, projectId: selection.projectId, repoId: "repo-app" },
        gatewayDelivery: {
          branch: selection.branch,
          projectId: "prj_gateway",
          repoId: "repo-gateway",
        },
        effects: [
          ...plan.effects,
          { id: "delivery", kind: "delivery", description: "Observe app delivery" },
          {
            id: "gateway-delivery",
            kind: "gateway-delivery",
            description: "Observe Gateway delivery",
          },
        ],
        release: { ...plan.release, sha256: createHash("sha256").update(manifest).digest("hex") },
      });
      f.deps.plan = vi.fn(async () => selectedPlan);
      const execute = await prepared(f);
      f.approve();
      const operator = f.row?.record.operator;
      if (operator === undefined) {
        throw new Error("Missing planned fixture operator");
      }
      const candidate = (kind: "app" | "gateway") => ({
        branch: selection.branch,
        deploymentId: `dpl_${kind}`,
        operationRef: execute.operationRef,
        origin: `https://${kind}-preview.example.test`,
        projectId: kind === "app" ? selection.projectId : "prj_gateway",
        readyState: "READY",
        repoId: `repo-${kind}`,
      });
      operator.deliveryCandidates = [candidate("app")];
      operator.gatewayDeliveryCandidates = [candidate("gateway")];
      operator.deliveredDeploymentId = "dpl_app";
      operator.deliveredGatewayDeploymentId = "dpl_gateway";

      const workload = {
        audience: "https://vercel.com/team_fixture",
        environment: "preview",
        issuer: "https://oidc.vercel.com/team_fixture",
        ownerId: target.scopeId,
        projectId: "prj_operator",
        subject: "fixture-builder",
      };
      const worker = {
        executablePath: "/fixture-worker",
        id: "fixture-worker",
        operationScope: "auth-protected-schema-v1",
        sha256: "a".repeat(64),
        subcommand: "auth-protected-schema",
      };
      const configuration = readHostedOperatorSourceConfiguration({
        PROTECTED_HOSTED_OPERATOR_CONFIGURATION: JSON.stringify({
          applications: {
            [selection.appId]: {
              accessRoles: ["reviewer"],
              appDatabase: plan.appDatabase,
              branch: selection.branch,
              projectId: selection.projectId,
            },
          },
          authDatabase: plan.authDatabase,
          builderCallbackOrigin: "https://builder.example",
          catalogAppIds: [selection.appId],
          gateway: {
            authBrowserOrigin: "https://auth.example.test",
            branch: selection.branch,
            environment: "preview",
            gatewayOrigin: candidate("gateway").origin,
            gitSha: "d".repeat(40),
            projectId: "prj_gateway",
            protectedApplicationIds: [selection.appId],
            publicOrigin: "https://apps-preview.example.test",
            repoId: "repo-gateway",
            workload: { ...workload, projectId: "prj_gateway" },
          },
          nativeNeon: {
            configuration: {
              connector: "fixture",
              nativeStore: {
                configurationId: target.installationId,
                resourceId: "fixture-store",
                sourceProjectId: "prj_operator",
              },
              operator: {
                audience: workload.audience,
                environment: workload.environment,
                issuer: workload.issuer,
                ownerId: workload.ownerId,
                projectId: workload.projectId,
              },
            },
            scope: {
              branchId: selectedPlan.neon.branchId,
              endpointId: "ep-fixture",
              hostname: plan.neon.endpoint,
              maintenanceDatabase: "neondb",
              maintenanceRole: "neondb_owner",
              projectId: plan.neon.projectId,
            },
          },
          operator: {
            deploymentId: "dpl_operator_mutable_config",
            environment: "preview",
            origin: "https://operator.example",
            projectId: "prj_operator",
          },
          sandbox: {
            accessWorker: worker,
            authProposal: { executablePath: "/proposal", id: "proposal", sha256: "b".repeat(64) },
            authWorker: worker,
            image: "fixture",
            projectId: "prj_operator",
            resourcesWorker: worker,
            teamId: target.scopeId,
            workers: { [selection.appId]: worker },
          },
          teamId: target.scopeId,
          workloadPolicy: { ...workload, projectId: "prj_builder" },
        }),
      });
      const reader: AppRuntimeSnapshotReader = {
        readIdentity: async () => ({
          branch: selectedPlan.neon.branchId,
          can_create: false,
          can_temp: false,
          comment: `protected-resource:v1:app_database:${plan.appDatabase.resourceId}:database`,
          database: plan.appDatabase.database,
          endpoint: "ep-fixture",
          login: plan.appDatabase.runtimeRole,
          owner: plan.appDatabase.migratorRole,
          owns_public_objects: false,
          privileged_membership: false,
          project: plan.neon.projectId,
          rolbypassrls: false,
          rolcreatedb: false,
          rolcreaterole: false,
          role: plan.appDatabase.runtimeRole,
          rolreplication: false,
          rolsuper: false,
        }),
        readOrganization: async (scope) => ({
          ok: true,
          data: {
            active_base_revision: plan.release.id,
            active_effective_artifact_hash: artifactHash,
            active_schema_revision_id: 7,
            app_id: scope.appId,
            customer_id: scope.organizationId,
            releases: [
              {
                artifact_hashes: {
                  base: artifactHash,
                  effective: artifactHash,
                  schema: "d".repeat(64),
                },
                base_revision: plan.release.id,
                preparation: { state: "active" },
                release_id: plan.release.id,
                runtime_schema: { status: "stored_schema_hash_matches" },
                schema_revision_id: 7,
              },
            ],
          },
        }),
      };
      const realReadiness = appReadiness.createHostedOperatorAppReadiness;
      const richResults: Awaited<ReturnType<ReturnType<typeof realReadiness>>>[] = [];
      const readRuntimeSnapshot = vi.fn<appReadiness.ReadAppRuntimeSnapshot>(
        async (_url, read) => await read(reader),
      );
      vi.spyOn(appReadiness, "createHostedOperatorAppReadiness").mockImplementation(
        (dependencies) => {
          const verify = realReadiness({ ...dependencies, readRuntimeSnapshot });
          return async (input) => {
            const richResult = await verify(input);
            richResults.push(richResult);
            return richResult;
          };
        },
      );
      const payloads = new Map<string, object>();
      for (const kind of ["app", "gateway", "operator"] as const) {
        const projectId = kind === "app" ? selection.projectId : `prj_${kind}`;
        payloads.set(`/v9/projects/${projectId}`, { id: projectId, accountId: target.scopeId });
        payloads.set(`/v13/deployments/dpl_${kind}`, {
          id: `dpl_${kind}`,
          projectId,
          ownerId: target.scopeId,
          readyState: "READY",
          target: null,
          gitSource: { ref: selection.branch },
          url: `${kind}-preview.example.test`,
          env: [],
        });
        payloads.set(`/v10/projects/${projectId}/env`, { envs: [] });
      }
      payloads.set("/v2/deployments/dpl_gateway/aliases", {
        aliases: [{ alias: "apps-preview.example.test" }],
      });
      const publicJwk = generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" });
      const fetcher = vi.fn<typeof fetch>(async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input);
        expect(init?.method).toBe("GET");
        if (url.origin === candidate("gateway").origin) {
          expect(url.pathname).toBe("/_platform/jwks.json");
          return Response.json({ keys: [{ ...publicJwk, kid: "fixture-key" }] });
        }
        expect(url.origin).toBe("https://api.vercel.com");
        expect(url.searchParams.get("teamId")).toBe(target.scopeId);
        const payload = payloads.get(url.pathname);
        if (payload === undefined) {
          throw new Error("Unexpected synthetic provider request");
        }
        return Response.json(payload);
      });
      vi.stubGlobal("fetch", fetcher);
      const controlPlane = {
        assertAuthorized: vi.fn(async () => {
          if (scenario === "authority_denied") {
            throw new HostedOperatorError("authorization_required");
          }
          await f.deps.assertAuthorized({ authority, target, plan: selectedPlan });
        }),
        store: f.deps.store,
        readResourceBindings: vi.fn(async () => ({
          appDatabase: { runtimeUrl: environment.SPEND_REVIEW_DATABASE_URL },
        })),
        readGeneratedSelection: vi.fn(async () => ({
          artifactRef: selectedPlan.release.artifactRef,
          manifestSha256: selectedPlan.release.sha256,
          releaseId: scenario === "release_mismatch" ? "other-release" : selectedPlan.release.id,
        })),
        readGeneratedRelease: vi.fn(async () => ({
          files: {
            "release-manifest.json":
              scenario === "manifest_mismatch" ? Buffer.from("wrong-manifest") : manifest,
          },
        })),
        readCredential: vi.fn(async () => ({
          binding: {
            active: true,
            installationId: target.installationId,
            scopeId: target.scopeId,
            scopeType: target.scopeType,
          },
          token: "fixture-private-owner-token",
        })),
      };
      const composed = composeHostedOperatorDependencies(
        configuration,
        // SAFETY: Only verify is delegated; all its control-plane ports are implemented here, and the real inventory and readiness checks run over synthetic transports.
        // oxlint-disable-next-line anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- This fixture intentionally implements only the final verifier's control-plane ports.
        controlPlane as unknown as Parameters<typeof composeHostedOperatorDependencies>[1],
      );
      const verify = vi.fn(composed.verify);
      f.deps.verify = verify;
      const log = vi.spyOn(console, "info").mockImplementation(() => {});
      try {
        if (initialScenario !== "ready") {
          const denied = await f.client.request(execute);
          expect(denied).toMatchObject({
            status: "blocked",
            code:
              initialScenario === "authority_denied"
                ? "authorization_required"
                : "operator_unavailable",
          });
          expect(f.row?.record.proof).toBeUndefined();
          expect(readRuntimeSnapshot).not.toHaveBeenCalled();
          expect(richResults).toHaveLength(0);
          scenario = "ready";
        }
        const result = await f.client.request(execute);
        expect(f.deps.executeEffect).toHaveBeenCalledTimes(selectedPlan.effects.length);
        expect(fetcher).toHaveBeenCalled();
        const deploymentReads = fetcher.mock.calls.map(
          ([input]) => new URL(input instanceof Request ? input.url : input).pathname,
        );
        expect(deploymentReads).toContain("/v13/deployments/dpl_operator");
        expect(deploymentReads).not.toContain("/v13/deployments/dpl_operator_mutable_config");
        expect(readRuntimeSnapshot).toHaveBeenCalledOnce();
        const [richResult] = richResults;
        expect(richResult).toMatchObject({
          actors: 0,
          authenticatedBehavior: "unassessed",
          source: "reviewed-plan-app-runtime",
          resourceId: selectedPlan.appDatabase.resourceId,
          observations: [{ organizationId: "synthetic-org" }],
        });
        expect(richResult?.observedAt).toEqual(expect.any(String));
        expect(hostedRuntimeProofSchema.safeParse(richResult).success).toBe(false);
        expect(log.mock.calls).not.toContainEqual([
          "[builder:hosted-neon-consent]",
          expect.objectContaining({
            executionFailure: { stage: "final_proof_parse", errorClass: "validation_error" },
          }),
        ]);
        expect(result).toMatchObject({ status: "prepared", authenticatedBehavior: "unassessed" });
        const persisted = hostedRuntimeProofSchema.parse(f.row?.record.proof);
        expect(persisted).toMatchObject({
          actors: 0,
          authenticatedBehavior: "unassessed",
          tenants: 1,
        });
        expect(Object.keys(persisted).toSorted()).toEqual([
          "actors",
          "artifactHash",
          "authenticatedBehavior",
          "manifestSha256",
          "releaseId",
          "tenants",
        ]);
        expect(persisted).toEqual(await verify.mock.results.at(-1)?.value);
        const bindings = await f.client.bindings({
          action: "bindings",
          operationRef: execute.operationRef,
          selection,
        });
        expect(bindings.proof).toEqual(persisted);
        expect(bindings.nativePreview).toMatchObject({
          app: candidate("app"),
          gateway: candidate("gateway"),
        });
        expect(readRuntimeSnapshot).toHaveBeenCalledTimes(2);
        expect(f.deps.executeEffect).toHaveBeenCalledTimes(selectedPlan.effects.length);
      } finally {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        log.mockRestore();
      }
    },
  );
});

describe("closed prepare final verification diagnostics", () => {
  const finalFixture = async () => {
    const f = fixture();
    f.deps.plan = vi.fn(async () =>
      hostedOperatorPlanSchema.parse({
        ...plan,
        effects: [
          ...Array.from({ length: 6 }, (_, index) => ({
            id: `resource-${index}`,
            kind: "resources",
            description: "Observe an approved resource",
          })),
          ...plan.effects,
        ],
      }),
    );
    const request = await prepared(f);
    f.approve();
    const execute = async () =>
      operatorPublicResultSchema.parse(
        await (
          await f.handler(
            new Request("https://operator.example/v1/runtime", {
              method: "POST",
              headers: {
                "content-type": "application/json",
                authorization: "Bearer fixture-service-identity",
                "x-vercel-trusted-oidc-idp-token": "fixture-service-identity",
                [OPERATOR_EXECUTION_OBSERVATION_HEADER]: OPERATOR_EXECUTION_OBSERVATION_PREFERENCE,
              },
              body: JSON.stringify({ ...request, ownerContext }),
            }),
          )
        ).json(),
      );
    return { f, execute };
  };

  it("reports the original physical authority error after ten receipts before verifier entry", async () => {
    const { f, execute } = await finalFixture();
    const privateError = new TypeError("private-physical-lease private-token");
    let rejected = false;
    let captured: unknown;
    f.deps.withResourceLease = async (_input, run) => {
      try {
        return await run(async () => {
          if (f.row?.record.operator?.receipts.length === 10 && !rejected) {
            rejected = true;
            throw privateError;
          }
        });
      } catch (error) {
        captured = error;
        throw error;
      }
    };
    const verify = vi.spyOn(f.deps, "verify");
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      expect(await execute()).toMatchObject({ status: "blocked", code: "operator_unavailable" });
      expect(captured).toBe(privateError);
      expect(verify).not.toHaveBeenCalled();
      expect(f.deps.executeEffect).toHaveBeenCalledTimes(10);
      expect(f.row?.record.proof).toBeUndefined();
      expect(f.row?.record.leaseId).toBeUndefined();
      expect(f.row?.record.executionObservation).toMatchObject({
        state: "settled",
        outcome: { status: "blocked", code: "operator_unavailable" },
      });
      expect(log.mock.calls).toContainEqual([
        "[builder:hosted-neon-consent]",
        expect.objectContaining({
          executionFailure: { stage: "final_authority", errorClass: "type_error" },
        }),
      ]);
      expect(JSON.stringify(log.mock.calls)).not.toContain("resource_lease");
      expect(JSON.stringify(log.mock.calls)).not.toContain(privateError.message);
    } finally {
      log.mockRestore();
    }
  });

  it("reports a raw verifier entry rejection and retains its blocked result through settlement", async () => {
    const { f, execute } = await finalFixture();
    const privateError = new TypeError("private-verifier-entry private-token");
    const verify = vi.spyOn(f.deps, "verify").mockRejectedValue(privateError);
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      expect(await execute()).toMatchObject({ status: "blocked", code: "operator_unavailable" });
      expect(verify).toHaveBeenCalledOnce();
      expect(f.deps.executeEffect).toHaveBeenCalledTimes(10);
      expect(f.row?.record.proof).toBeUndefined();
      expect(f.row?.record.executionObservation).toMatchObject({
        state: "settled",
        outcome: { status: "blocked", code: "operator_unavailable" },
      });
      expect(log.mock.calls).toContainEqual([
        "[builder:hosted-neon-consent]",
        expect.objectContaining({
          executionFailure: { stage: "final_verifier_entry", errorClass: "type_error" },
        }),
      ]);
      const output = JSON.stringify(log.mock.calls);
      expect(output).not.toContain("final_proof_parse");
      expect(output).not.toContain("resource_lease");
      expect(output).not.toContain(privateError.message);
    } finally {
      log.mockRestore();
    }
  });

  it.each(["execution_settlement", "final_lease_release"] as const)(
    "retains the original authority classification when %s also fails",
    async (stage) => {
      const { f, execute } = await finalFixture();
      const privateError = new TypeError("private-physical-lease");
      let rejected = false;
      f.deps.withResourceLease = async (_input, run) =>
        await run(async () => {
          if (f.row?.record.operator?.receipts.length === 10 && !rejected) {
            rejected = true;
            throw privateError;
          }
        });
      const compareAndSet = f.deps.store.compareAndSet;
      f.deps.store.compareAndSet = async (input) => {
        const settlementFailure =
          stage === "execution_settlement" &&
          input.record.executionObservation?.state === "settled";
        const leaseReleaseFailure =
          stage === "final_lease_release" &&
          f.row?.record.leaseId !== undefined &&
          input.record.leaseId === undefined;
        if (settlementFailure || leaseReleaseFailure) {
          throw new HostedOperatorError("resource_mismatch");
        }
        return await compareAndSet(input);
      };
      const verify = vi.spyOn(f.deps, "verify");
      const log = vi.spyOn(console, "info").mockImplementation(() => {});
      try {
        expect(await execute()).toMatchObject({
          status: "blocked",
          code: stage === "execution_settlement" ? "operator_unavailable" : "resource_mismatch",
        });
        expect(verify).not.toHaveBeenCalled();
        expect(f.deps.executeEffect).toHaveBeenCalledTimes(10);
        expect(log.mock.calls).toContainEqual([
          "[builder:hosted-neon-consent]",
          expect.objectContaining({
            executionFailure: { stage: "final_authority", errorClass: "type_error" },
          }),
        ]);
        expect(log.mock.calls).toContainEqual([
          "[builder:hosted-neon-consent]",
          expect.objectContaining({
            executionFailure: { stage, errorClass: "operator_error", code: "resource_mismatch" },
          }),
        ]);
        expect(JSON.stringify(log.mock.calls)).not.toContain("resource_lease");
        expect(JSON.stringify(log.mock.calls)).not.toContain(privateError.message);
      } finally {
        log.mockRestore();
      }
    },
  );

  it("retains release binding validation and its original public denial", async () => {
    const { f, execute } = await finalFixture();
    vi.spyOn(f.deps, "verify").mockResolvedValue({ ...proof, releaseId: "different-release" });
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      expect(await execute()).toMatchObject({ status: "blocked", code: "resource_mismatch" });
      expect(f.row?.record.proof).toBeUndefined();
      expect(log.mock.calls).toContainEqual([
        "[builder:hosted-neon-consent]",
        expect.objectContaining({
          executionFailure: {
            stage: "final_proof_parse",
            errorClass: "operator_error",
            code: "resource_mismatch",
          },
        }),
      ]);
    } finally {
      log.mockRestore();
    }
  });

  it("classifies final proof publication failure and retries without duplicate effects", async () => {
    const { f, execute } = await finalFixture();
    const compareAndSet = f.deps.store.compareAndSet;
    const privateError = Object.assign(new Error("private-publication-query private-token"), {
      code: "42501",
    });
    f.deps.store.compareAndSet = async (input) => {
      if (input.record.proof !== undefined) {
        throw privateError;
      }
      return await compareAndSet(input);
    };
    const verify = vi.spyOn(f.deps, "verify");
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      expect(await execute()).toMatchObject({ status: "blocked", code: "operator_unavailable" });
      expect(f.row?.record.proof).toBeUndefined();
      expect(f.row?.record.leaseId).toBeUndefined();
      expect(log.mock.calls).toContainEqual([
        "[builder:hosted-neon-consent]",
        expect.objectContaining({
          executionFailure: {
            stage: "final_proof_publication",
            errorClass: "unexpected",
            sqlState: "42501",
          },
        }),
      ]);
      expect(JSON.stringify(log.mock.calls)).not.toContain(privateError.message);
      f.deps.store.compareAndSet = compareAndSet;
      expect(await execute()).toMatchObject({ status: "prepared" });
      expect(verify).toHaveBeenCalledTimes(2);
      expect(f.deps.executeEffect).toHaveBeenCalledTimes(10);
    } finally {
      log.mockRestore();
    }
  });

  it.each([false, true])(
    "classifies resource lease cleanup with journal release failure %s",
    async (releaseFails) => {
      const { f, execute } = await finalFixture();
      const withResourceLease = f.deps.withResourceLease;
      f.deps.withResourceLease = async (input, run) => {
        await withResourceLease(input, run);
        throw new TypeError("private-resource-lease-cleanup");
      };
      const compareAndSet = f.deps.store.compareAndSet;
      f.deps.store.compareAndSet = async (input) => {
        if (
          releaseFails &&
          f.row?.record.leaseId !== undefined &&
          input.record.leaseId === undefined
        ) {
          throw new HostedOperatorError("resource_mismatch");
        }
        return await compareAndSet(input);
      };
      const log = vi.spyOn(console, "info").mockImplementation(() => {});
      try {
        expect(await execute()).toMatchObject({
          status: "blocked",
          code: releaseFails ? "resource_mismatch" : "operator_unavailable",
        });
        expect(f.row?.record.proof).toEqual(proof);
        expect(f.row?.record.leaseId !== undefined).toBe(releaseFails);
        expect(f.deps.executeEffect).toHaveBeenCalledTimes(10);
        expect(log.mock.calls).toContainEqual([
          "[builder:hosted-neon-consent]",
          expect.objectContaining({
            executionFailure: { stage: "resource_lease", errorClass: "type_error" },
          }),
        ]);
        if (releaseFails) {
          expect(log.mock.calls).toContainEqual([
            "[builder:hosted-neon-consent]",
            expect.objectContaining({
              executionFailure: {
                stage: "final_lease_release",
                errorClass: "operator_error",
                code: "resource_mismatch",
              },
            }),
          ]);
        }
      } finally {
        log.mockRestore();
      }
    },
  );

  it("classifies journal lease clearing failure without repeating completed effects", async () => {
    const { f, execute } = await finalFixture();
    const compareAndSet = f.deps.store.compareAndSet;
    f.deps.store.compareAndSet = async (input) => {
      if (f.row?.record.leaseId !== undefined && input.record.leaseId === undefined) {
        throw new TypeError("private-journal-lease-clear");
      }
      return await compareAndSet(input);
    };
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      expect(await execute()).toMatchObject({ status: "blocked", code: "operator_unavailable" });
      expect(f.row?.record.proof).toEqual(proof);
      expect(f.row?.record.leaseId).toBeDefined();
      expect(f.deps.executeEffect).toHaveBeenCalledTimes(10);
      expect(log.mock.calls).toContainEqual([
        "[builder:hosted-neon-consent]",
        expect.objectContaining({
          executionFailure: { stage: "final_lease_release", errorClass: "type_error" },
        }),
      ]);
      expect(JSON.stringify(log.mock.calls)).not.toContain("resource_lease");
    } finally {
      log.mockRestore();
    }
  });
});

describe("completed owned Gateway binding convergence", () => {
  it("reconciles the completed binding under its original approval and replaces only its receipt", async () => {
    const f = fixture();
    const gatewayPlan = hostedOperatorPlanSchema.parse({
      ...plan,
      gatewayBindings: adoptedGatewayPlan().gatewayBindings,
      effects: [
        ...plan.effects,
        { description: "Bind Gateway", id: "gateway-bindings", kind: "gateway-bindings" },
      ],
    });
    f.deps.plan = async () => gatewayPlan;
    const request = await prepared(f);
    f.approve();
    expect((await f.client.request(request)).status).toBe("prepared");
    const before = hostedRuntimeJournalRecordSchema.parse(f.row?.record);
    const beforeOperator = hostedOperatorRecordSchema.parse(before.operator);
    const calls = vi.mocked(f.deps.executeEffect).mock.calls.length;
    const { reconcile, executeEffect } = f.deps;
    let stale = true;
    f.deps.reconcile = async (input) => {
      if (input.effect.kind === "gateway-bindings" && stale) {
        return { status: "retryable", resourceVersion: "observed-old-owned-config" };
      }
      return await reconcile(input);
    };
    f.deps.executeEffect = async (input) => {
      expect(input.effect.kind).toBe("gateway-bindings");
      expect(input.workerAttemptId).toBeTruthy();
      expect(f.row?.record.operator?.pendingEffectId).toBe(input.effect.id);
      await input.assertCurrent();
      const receipt = {
        ...(await executeEffect(input)),
        resourceVersion: "observed-current-owned-config",
      };
      f.applied.set(input.effect.id, { ...receipt, fenceGeneration: input.fenceGeneration });
      stale = false;
      return receipt;
    };
    expect((await f.client.request(request)).status).toBe("prepared");
    expect(vi.mocked(executeEffect).mock.calls).toHaveLength(calls + 1);
    const after = hostedRuntimeJournalRecordSchema.parse(f.row?.record);
    const afterOperator = hostedOperatorRecordSchema.parse(after.operator);
    expect(
      afterOperator.receipts.filter((receipt) => receipt.effectId !== "gateway-bindings"),
    ).toEqual(beforeOperator.receipts.filter((receipt) => receipt.effectId !== "gateway-bindings"));
    expect(
      afterOperator.receipts.filter((receipt) => receipt.effectId === "gateway-bindings"),
    ).toMatchObject([{ resourceVersion: "observed-current-owned-config" }]);
    expect(after.privateState).toEqual(before.privateState);
    expect(afterOperator.operationRef).toBe(beforeOperator.operationRef);
    expect(afterOperator.approvalId).toBe(beforeOperator.approvalId);
    expect(after.approvedByCallId).toBe(before.approvedByCallId);
    expect((await f.client.request(request)).status).toBe("prepared");
    expect(vi.mocked(executeEffect).mock.calls).toHaveLength(calls + 1);
    expect(f.row?.record.operator?.receipts).toHaveLength(beforeOperator.receipts.length);
    expect(
      f.row?.record.operator?.receipts.filter((receipt) => receipt.effectId === "gateway-bindings"),
    ).toHaveLength(1);
  });

  it("retains a completed Gateway receipt when fresh reconciliation is unknown", async () => {
    const f = fixture();
    f.deps.plan = async () =>
      hostedOperatorPlanSchema.parse({
        ...plan,
        gatewayBindings: adoptedGatewayPlan().gatewayBindings,
        effects: [
          ...plan.effects,
          { description: "Bind Gateway", id: "gateway-bindings", kind: "gateway-bindings" },
        ],
      });
    const request = await prepared(f);
    f.approve();
    expect((await f.client.request(request)).status).toBe("prepared");
    const receipts = structuredClone(f.row?.record.operator?.receipts);
    const calls = vi.mocked(f.deps.executeEffect).mock.calls.length;
    f.unknown();
    expect((await f.client.request(request)).code).toBe("reconciliation_required");
    expect(f.row?.record.operator?.receipts).toEqual(receipts);
    expect(f.deps.executeEffect).toHaveBeenCalledTimes(calls);
  });
});
