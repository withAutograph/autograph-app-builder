/* oxlint-disable eslint/require-await -- The provider and journal fixtures are deliberately async. */
import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { z } from "zod";

import { nativeTargetAuthOnlyTestPlan } from "./native-target-auth-only-plan-schema.test";
import { nativeTargetAuthOnlyPlanDigest } from "./native-target-auth-only-plan-schema";
import {
  nativeTargetAuthOnlyDeliveryPlanDigest,
  nativeTargetAuthOnlyDeliveryPlanSchema,
} from "./native-target-auth-only-delivery-plan";
import { projectNativeTargetAuthOnlyGatewayBinding } from "./native-target-auth-only-gateway-projection";
import {
  buildNativeTargetAuthOnlyFinalRoutingPlanBytes,
  createNativeTargetAuthOnlyFinalRouting,
  createPostgresNativeTargetAuthOnlyFinalRoutingStore,
  nativeTargetAuthOnlyFinalRoutingPlanDigest,
  nativeTargetAuthOnlyFinalRoutingPlanSchema,
  nativeTargetAuthOnlyFinalRoutingRecordSchema,
} from "./native-target-auth-only-final-routing";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const plan = nativeTargetAuthOnlyTestPlan();
const { authority } = plan.origin;
const target = {
  appId: plan.appId,
  branch: plan.branch,
  environment: "preview" as const,
  installationId: plan.project.installationId,
  projectId: "app-project",
  scopeId: plan.project.teamId,
  scopeType: "team" as const,
  sessionId: plan.origin.publicSessionId,
};
const parentOperationRef = "11111111-1111-4111-a111-111111111111";
const routingOperationRef = "22222222-2222-4222-a222-222222222222";
const gatewayProjectId = "gateway-project";
const gatewayRepo = "gateway-repo";
const gatewayBranch = "gateway-pilot";
const gatewaySha = "f".repeat(40);
const publicOrigin = "https://pilot.example";
const deliveryPlan = nativeTargetAuthOnlyDeliveryPlanSchema.parse({
  authOnlyPlanDigest: nativeTargetAuthOnlyPlanDigest(plan),
  delivery: {
    action: "prepare",
    delivery: {
      branch: target.branch,
      gitSha: plan.publishedSource.gitSha,
      projectId: target.projectId,
      repoId: plan.publishedSource.repositoryId,
    },
    effects: [
      { id: "auth-only-gateway-preview", kind: "gateway-delivery" },
      { id: "auth-only-app-preview", kind: "delivery" },
    ],
    gatewayDelivery: {
      branch: gatewayBranch,
      gitRef: gatewayBranch,
      gitSha: gatewaySha,
      projectId: gatewayProjectId,
      repoId: gatewayRepo,
    },
    publicGateway: {
      authBrowserOrigin: publicOrigin,
      branch: gatewayBranch,
      gatewayOrigin: "https://bootstrap-gateway.vercel.app",
      origin: publicOrigin,
      projectId: gatewayProjectId,
    },
    stage: "app",
  },
  effects: [
    { id: "auth-only-gateway-preview", kind: "gateway-delivery" },
    { id: "auth-only-app-preview", kind: "delivery" },
  ],
  kind: "native-target-auth-only-delivery",
  resourcePlanDigest: "a".repeat(64),
  source: {
    branch: plan.branch,
    gitSha: plan.publishedSource.gitSha,
    repositoryId: plan.publishedSource.repositoryId,
  },
  target,
  version: 1,
});
const parentDigest = nativeTargetAuthOnlyDeliveryPlanDigest(
  Buffer.from(JSON.stringify(deliveryPlan)),
);
const approval = (planDigest: string, callId: string) => ({
  callId,
  observedAt: "2026-11-06T12:00:00.000Z",
  outcome: "approved" as const,
  planDigest,
  publicSessionId: target.sessionId,
  requestId: `request-${callId}`,
  responderPrincipalId: authority.ownerUserId,
  sourceDigest: planDigest,
});
const bootstrap = {
  branch: gatewayBranch,
  deploymentId: "dpl-bootstrap",
  operationRef: parentOperationRef,
  origin: "https://bootstrap-gateway.vercel.app",
  projectId: gatewayProjectId,
  readyState: "READY" as const,
  repoId: gatewayRepo,
};
const app = {
  branch: target.branch,
  deploymentId: "dpl-app",
  operationRef: parentOperationRef,
  origin: "https://pilot-app.vercel.app",
  projectId: target.projectId,
  projectName: plan.project.name,
  readyState: "READY" as const,
  repoId: plan.publishedSource.repositoryId,
  scopeSlug: "team-fixture",
};
const source = {
  audience: "https://vercel.com/team",
  environment: "preview" as const,
  issuer: "https://oidc.vercel.com/team",
  ownerId: target.scopeId,
  projectId: gatewayProjectId,
  publicOrigin,
  subject: "owner:team:project:gateway:environment:preview",
};
const projectionBefore = JSON.stringify({
  bindings: [],
  provenance: "trusted-operator-published-provider-projection",
  source,
  version: 1,
});

const fixture = () => {
  const parentGuard = vi.fn(async () => {});
  const routingGuard = vi.fn(async () => {});
  const projection = {
    appReceipt: app,
    environment: {
      approval: approval(parentDigest, "parent-approval"),
      assertCurrent: parentGuard,
      authority,
      deliveryPlan,
      effect: "gateway" as const,
      fenceGeneration: 7,
      operationRef: parentOperationRef,
      plan,
      signal: new AbortController().signal,
      target,
    },
    source,
  };
  const nextProjection = projectNativeTargetAuthOnlyGatewayBinding(
    projection,
    projectionBefore,
    app,
  );
  const routingPlanBytes = buildNativeTargetAuthOnlyFinalRoutingPlanBytes({
    app,
    bootstrap,
    environment: projection.environment,
    operationRef: routingOperationRef,
    projectionRow: {
      physicalBranch: gatewayBranch,
      projectId: gatewayProjectId,
      rowId: "row",
      value: projectionBefore,
    },
    source,
  });
  const routingPlan = nativeTargetAuthOnlyFinalRoutingPlanSchema.parse(
    JSON.parse(routingPlanBytes.toString("utf-8")),
  );
  const routingPlanDigest = nativeTargetAuthOnlyFinalRoutingPlanDigest(routingPlanBytes);
  const routingApproval = approval(routingPlanDigest, "routing-approval");
  const record = nativeTargetAuthOnlyFinalRoutingRecordSchema.parse({
    approval: routingApproval,
    kind: "native-target-auth-only-final-routing",
    operationRef: routingOperationRef,
    refreshAttempted: false,
    refreshCandidates: [],
    routingPlanBase64: routingPlanBytes.toString("base64"),
    routingPlanDigest,
    version: 1,
  });
  let row = { record, revision: 1 };
  let currentProjection = projectionBefore;
  let alias = bootstrap.deploymentId;
  let deploymentExists = false;
  const flags = {
    aliasArrives: true,
    aliasMovesAfterRefresh: false,
    createArrives: true,
    loseAlias: false,
    loseCreate: false,
    refreshReady: true,
  };
  const refreshId = "dpl-refresh";
  const meta = {
    autograph_operator_effect: "auth-only-gateway-routing-refresh",
    autograph_operator_operation: routingOperationRef,
    autograph_operator_plan: routingPlanDigest,
  };
  const gitSource = { ref: gatewayBranch, repoId: gatewayRepo, sha: gatewaySha, type: "github" };
  const events: string[] = [];
  const fetcher: typeof fetch = async (raw, init) => {
    const url = new URL(raw instanceof Request ? raw.url : raw);
    const method = init?.method ?? "GET";
    expect(url.searchParams.get("teamId")).toBe(target.scopeId);
    if (url.pathname === "/v4/aliases/pilot.example") {
      return Response.json({
        alias: "pilot.example",
        deploymentId: alias,
        projectId: gatewayProjectId,
      });
    }
    if (url.pathname === "/v7/deployments") {
      return Response.json({ deployments: deploymentExists ? [{ meta, uid: refreshId }] : [] });
    }
    if (url.pathname === `/v9/projects/${gatewayProjectId}`) {
      return Response.json({
        accountId: target.scopeId,
        framework: "nextjs",
        id: gatewayProjectId,
        link: { repoId: gatewayRepo, type: "github" },
        name: "gateway",
      });
    }
    if (url.pathname === `/v2/teams/${target.scopeId}`) {
      return Response.json({ id: target.scopeId, slug: "team-fixture" });
    }
    if (url.pathname === "/v13/deployments" && method === "POST") {
      expect(currentProjection).toBe(nextProjection);
      expect(row.record.refreshAttempted).toBe(true);
      expect(JSON.parse(z.string().parse(init?.body))).toMatchObject({
        gitSource,
        meta,
        project: gatewayProjectId,
      });
      events.push("refresh");
      deploymentExists = flags.createArrives;
      if (flags.aliasMovesAfterRefresh) {
        alias = "dpl-unrelated";
      }
      if (flags.loseCreate) {
        throw new Error("lost create");
      }
      return Response.json({ id: refreshId });
    }
    if (url.pathname === `/v13/deployments/${refreshId}`) {
      if (!deploymentExists) {
        return new Response(null, { status: 404 });
      }
      return Response.json({
        customEnvironment: null,
        gitSource,
        id: refreshId,
        meta,
        oidcTokenClaims: { environment: "preview" },
        ownerId: target.scopeId,
        projectId: gatewayProjectId,
        readyState: flags.refreshReady ? "READY" : "ERROR",
        target: null,
        url: "refresh-gateway.vercel.app",
      });
    }
    if (url.pathname === `/v2/deployments/${refreshId}/aliases` && method === "POST") {
      expect(alias).toBe(bootstrap.deploymentId);
      expect(row.record.refreshCandidates[0]).toMatchObject({
        deploymentId: refreshId,
        gatewayAliasAttempted: true,
      });
      events.push("alias");
      if (flags.aliasArrives) {
        alias = refreshId;
      }
      if (flags.loseAlias) {
        throw new Error("lost alias response");
      }
      return Response.json({ alias: "pilot.example" });
    }
    throw new Error(`Unexpected provider fixture request ${method} ${url.pathname}`);
  };
  const openProjection = async () => {
    const read = async () => ({
      physicalBranch: gatewayBranch,
      projectId: gatewayProjectId,
      rowId: "row",
      value: currentProjection,
    });
    return {
      patch: async (
        before: Awaited<ReturnType<typeof read>>,
        value: string,
        assertAuthorized: () => Promise<void>,
      ) => {
        expect(before).toEqual(await read());
        expect(row.record.projectionAttempt).toEqual(routingPlan.projection);
        await assertAuthorized();
        currentProjection = value;
        events.push("projection");
      },
      read,
    };
  };
  const execute = createNativeTargetAuthOnlyFinalRouting(
    {
      assertCatalogApp: async () => {},
      fetch: fetcher,
      readCredential: async () => ({
        token: "private-fixture",
        binding: {
          active: true,
          displayName: "Fixture",
          installationId: target.installationId,
          scopeId: target.scopeId,
          scopeType: "team",
          slug: "team-fixture",
          plan: "pro",
          updatedAt: new Date(),
        },
      }),
      readRetainedParent: async () => ({ bootstrap, app }),
      store: {
        compareAndSet: async (revision, next) => {
          if (row.revision !== revision) {
            // oxlint-disable-next-line unicorn/no-useless-undefined -- The store reports a lost CAS with undefined.
            return undefined;
          }
          row = { revision: revision + 1, record: structuredClone(next) };
          return structuredClone(row);
        },
        read: async () => structuredClone(row),
      },
    },
    {
      openProjection,
      reconcileApp: async () => ({ candidates: [app], selected: app, status: "applied" }),
    },
  );
  const input = {
    approval: routingApproval,
    assertCurrent: routingGuard,
    fenceGeneration: 8,
    projection,
    routingPlanBytes,
  };
  return {
    changeAlias: (value: string) => {
      alias = value;
    },
    events,
    flags,
    getRecord: () => row.record,
    input,
    routingApproval,
    routingPlanBytes,
    run: async () => execute(input),
  };
};

it("retains exact separately approved routing bytes in an owner and session scoped journal", async () => {
  const f = fixture();
  interface Row {
    requestId: string;
    requestDigest: string;
    revision: number;
    record: unknown;
    state: string;
  }
  const rows = new Map<string, Row>();
  const parameters = (where: SQL) => new PgDialect().sqlToQuery(where).params;
  const database = {
    insert: () => ({
      values: (row: Row) => ({
        onConflictDoNothing: async () => {
          if (!rows.has(row.requestId)) rows.set(row.requestId, structuredClone(row));
        },
      }),
    }),
    select: () => ({
      from: () => ({
        where: (where: SQL) => ({
          limit: async () => {
            const row = rows.get(String(parameters(where)[4]));
            return row === undefined ? [] : [structuredClone(row)];
          },
        }),
      }),
    }),
    update: () => ({
      set: (change: Partial<Row>) => ({
        where: (where: SQL) => ({
          returning: async () => {
            const values = parameters(where);
            const row = rows.get(String(values[4]));
            if (
              row === undefined ||
              row.revision !== values[5] ||
              row.requestDigest !== values[6]
            ) {
              return [];
            }
            const next = { ...row, ...change };
            rows.set(row.requestId, structuredClone(next));
            return [structuredClone(next)];
          },
        }),
      }),
    }),
  };
  const store = createPostgresNativeTargetAuthOnlyFinalRoutingStore(database);
  const key = {
    appId: target.appId,
    authority,
    operationRef: routingOperationRef,
    sessionId: target.sessionId,
  };
  const retained = await store.retain(key, f.routingPlanBytes, f.routingApproval);
  expect(retained.record.routingPlanBase64).toBe(f.routingPlanBytes.toString("base64"));
  expect(await store.read({ ...key, sessionId: "other-session" })).toBeUndefined();
  expect(await store.compareAndSet(key, 0, retained.record)).toBeUndefined();
  const plan = nativeTargetAuthOnlyFinalRoutingPlanSchema.parse(
    JSON.parse(f.routingPlanBytes.toString("utf-8")),
  );
  const intent = await store.compareAndSet(key, retained.revision, {
    ...retained.record,
    projectionAttempt: plan.projection,
  });
  expect(intent?.record.projectionAttempt).toEqual(plan.projection);
  expect(intent?.record.refreshAttempted).toBe(false);
  const changed = await store.compareAndSet(key, intent!.revision, {
    ...intent!.record,
    refreshAttempted: true,
  });
  expect(changed?.record.refreshAttempted).toBe(true);
});

it("keeps a READY app unprepared without the separate routing approval or verified alias", async () => {
  const noApproval = fixture();
  noApproval.input.approval = approval(parentDigest, "parent-approval");
  await expect(noApproval.run()).rejects.toThrow("authorization_required");
  expect(noApproval.events).toEqual([]);
  expect(noApproval.getRecord().refreshReceipt).toBeUndefined();

  const noAlias = fixture();
  noAlias.flags.aliasArrives = false;
  await expect(noAlias.run()).rejects.toThrow("reconciliation_required");
  expect(noAlias.events).toEqual(["projection", "refresh", "alias"]);
  expect(noAlias.getRecord().refreshReceipt).toBeUndefined();
});

it("records only a distinct pinned Gateway refresh after the stable alias reaches it", async () => {
  const f = fixture();
  const result = await f.run();
  expect(f.events).toEqual(["projection", "refresh", "alias"]);
  expect(result).toMatchObject({
    app,
    gateway: { deploymentId: "dpl-refresh", operationRef: routingOperationRef },
    status: "prepared",
  });
  expect(f.getRecord().refreshReceipt).toEqual(result.gateway);
  expect(await f.run()).toEqual(result);
  expect(f.events).toEqual(["projection", "refresh", "alias"]);
});

it("reconciles a lost accepted create and never repeats an unobserved refresh create", async () => {
  const accepted = fixture();
  accepted.flags.loseCreate = true;
  await expect(accepted.run()).rejects.toThrow();
  await expect(accepted.run()).resolves.toMatchObject({ status: "prepared" });
  expect(accepted.events).toEqual(["projection", "refresh", "alias"]);

  const absent = fixture();
  absent.flags.loseCreate = true;
  absent.flags.createArrives = false;
  await expect(absent.run()).rejects.toThrow();
  await expect(absent.run()).rejects.toThrow("reconciliation_required");
  expect(absent.events).toEqual(["projection", "refresh"]);
  expect(absent.getRecord().refreshReceipt).toBeUndefined();
});

it("reconciles a lost accepted alias and preserves a foreign alias preimage", async () => {
  const lost = fixture();
  lost.flags.loseAlias = true;
  await expect(lost.run()).rejects.toThrow("reconciliation_required");
  await expect(lost.run()).resolves.toMatchObject({ status: "prepared" });
  expect(lost.events).toEqual(["projection", "refresh", "alias"]);

  const foreign = fixture();
  foreign.changeAlias("dpl-unrelated");
  await expect(foreign.run()).rejects.toThrow("reconciliation_required");
  expect(foreign.events).toEqual([]);
});

it("leaves the stable alias alone if its preimage changes after creating the refresh", async () => {
  const f = fixture();
  f.flags.aliasMovesAfterRefresh = true;
  await expect(f.run()).rejects.toThrow("reconciliation_required");
  expect(f.events).toEqual(["projection", "refresh"]);
  expect(f.getRecord().refreshReceipt).toBeUndefined();
});

it("prepared readback refuses a refresh that is no longer READY without changing projection or alias", async () => {
  const f = fixture();
  await f.run();
  f.flags.refreshReady = false;
  await expect(f.run()).rejects.toThrow("reconciliation_required");
  expect(f.events).toEqual(["projection", "refresh", "alias"]);
});
