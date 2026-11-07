/* oxlint-disable eslint/no-await-in-loop -- Test runtime binding receipt order matches the durable provider contract. */
/* oxlint-disable eslint/require-await -- Test provider and store adapters return the same Promise contracts as production. */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createPublicReleaseGitHubProvider } from "./public-release-github-provider";
import {
  publicReleasePlanSchema,
  publicReleasePlanDigest,
  publicReleaseOperationRef,
} from "./public-release-contract";
import type { PublicReleaseRecord } from "./public-release-contract";
import { PublicReleaseProviderError } from "./public-release-provider-error";
import { createPublicReleaseHandler } from "./public-release-handler";
import type {
  PublicReleaseRow,
  PublicReleaseStore,
  PublicReleasePorts,
} from "./public-release-handler";
import { initialPublicReleaseRecord } from "./public-release-store";

import { authority, plan } from "./public-release-test-fixture";

const invocation = () => ({
  authority,
  callId: "current-call",
  sessionId: "saved-session",
  signal: new AbortController().signal,
});
const fixture = () => {
  let row: PublicReleaseRow | undefined;
  const store: PublicReleaseStore = {
    // oxlint-disable-next-line eslint/require-await -- Durable store test double.
    async compareAndSet(previous, record: PublicReleaseRecord) {
      if (!row || row.revision !== previous.revision) {
        // oxlint-disable-next-line unicorn/no-useless-undefined -- A stale CAS explicitly returns no row under the storage port.
        return undefined;
      }
      row = { ...row, record: structuredClone(record), revision: row.revision + 1 };
      return structuredClone(row);
    },
    // oxlint-disable-next-line eslint/require-await -- Durable store test double.
    async read(owner, operationRef) {
      return row &&
        owner.ownerUserId === row.record.plan.authority.ownerUserId &&
        operationRef === row.operationRef
        ? structuredClone(row)
        : undefined;
    },
    // oxlint-disable-next-line eslint/require-await -- Durable store test double.
    async reserve(selected) {
      row ??= {
        operationRef: publicReleaseOperationRef(selected),
        record: initialPublicReleaseRecord(selected),
        revision: 1,
      };
      return structuredClone(row);
    },
  };
  const applied = new Set<string>();
  const writes: string[] = [];
  const ports: PublicReleasePorts = {
    applyEffect: vi.fn<PublicReleasePorts["applyEffect"]>(async ({ effect, bindings }) => {
      if (effect === "bind-production-runtime") {
        for (const entry of plan.environment) {
          await bindings.claim(entry.key);
          await bindings.recordAccepted(entry.key, "env-owned");
          await bindings.recordVerified(entry.key);
        }
      }
      writes.push(effect);
      applied.add(effect);
    }),
    assertApproved: vi.fn<PublicReleasePorts["assertApproved"]>(async () => {}),
    assertAuthorized: vi.fn<PublicReleasePorts["assertAuthorized"]>(async () => {}),
    observe: vi.fn().mockResolvedValue({
      deploymentId: "active-native-deployment",
      environment: "production",
      projectId: plan.project.projectId,
      publicOrigin: plan.publicOrigin,
      releaseId: plan.runtime.releaseId,
      status: "ready",
    }),
    reconcileEffect: vi.fn<PublicReleasePorts["reconcileEffect"]>(async ({ effect }) =>
      applied.has(effect) ? "applied" : "not-applied",
    ),
    resolve: vi.fn().mockResolvedValue(plan),
    store,
    withTargetLease: async (_ctx, _plan, run) => await run(),
  };
  return { applied, handler: createPublicReleaseHandler(ports), ports, store, writes };
};
describe("public app release lifecycle", () => {
  it("reports Auth bootstrap as its separate approved purpose without authenticated app acceptance", async () => {
    const f = fixture();
    const bootstrap = publicReleasePlanSchema.parse({
      ...plan,
      purpose: "auth-bootstrap",
      runtime: { ...plan.runtime, realmEnrollmentRef: "55555555-5555-4555-a555-555555555555" },
    });
    f.ports.resolve = vi.fn().mockResolvedValue(bootstrap);
    const selected = await f.handler.plan(invocation(), plan.selection.appId);
    const result = await f.handler.release(
      invocation(),
      selected.operationRef,
      selected.planDigest,
    );
    expect(result).toMatchObject({
      authenticatedBehavior: "unassessed",
      purpose: "auth-bootstrap",
    });
  });

  it("uses one owned target and resumes without duplicate effects", async () => {
    const f = fixture();
    const ctx = invocation();
    const selected = await f.handler.plan(ctx, plan.selection.appId);
    expect(selected.plan.project.projectId).toBe(plan.project.projectId);
    expect(f.writes).toEqual([]);
    const first = await f.handler.release(ctx, selected.operationRef, selected.planDigest);
    expect(first).toMatchObject({ authenticatedBehavior: "unassessed", status: "ready" });
    expect(f.writes).toEqual(["bind-production-runtime", "publish-release-source"]);
    await f.handler.release(ctx, selected.operationRef, selected.planDigest);
    expect(f.writes).toHaveLength(2);
  });
  it("observes a pending native deployment from a new call without repeating approved effects", async () => {
    const f = fixture();
    const ctx = invocation();
    const selected = await f.handler.plan(ctx, plan.selection.appId);
    const observation = vi.mocked(f.ports.observe);
    observation.mockResolvedValueOnce({ status: "pending" });
    expect(await f.handler.release(ctx, selected.operationRef, selected.planDigest)).toMatchObject({
      status: "pending",
    });
    vi.mocked(f.ports.assertApproved).mockClear();
    vi.mocked(f.ports.reconcileEffect).mockClear();
    const followup = { ...ctx, callId: "later-read" };
    expect(
      await f.handler.observe(followup, selected.operationRef, selected.planDigest),
    ).toMatchObject({ authenticatedBehavior: "unassessed", status: "ready" });
    const readyRow = await f.store.read(authority, selected.operationRef);
    expect(readyRow?.record.observation).toMatchObject({
      deploymentId: "active-native-deployment",
      status: "ready",
    });
    expect(f.ports.assertApproved).not.toHaveBeenCalled();
    expect(f.ports.reconcileEffect).not.toHaveBeenCalled();
    expect(f.writes).toEqual(["bind-production-runtime", "publish-release-source"]);
    observation.mockResolvedValueOnce({ status: "pending" });
    expect(
      await f.handler.observe(followup, selected.operationRef, selected.planDigest),
    ).toMatchObject({ status: "pending" });
    const retainedRow = await f.store.read(authority, selected.operationRef);
    expect(retainedRow?.record.observation).toEqual(readyRow?.record.observation);
  });
  it("retains a dispatched unknown effect and never republishes blindly", async () => {
    const f = fixture();
    const ctx = invocation();
    const selected = await f.handler.plan(ctx, plan.selection.appId);
    f.ports.applyEffect = vi.fn().mockRejectedValue(new Error("lost provider response"));
    await expect(
      f.handler.release(ctx, selected.operationRef, selected.planDigest),
    ).rejects.toThrow("lost provider response");
    const saved = await f.store.read(authority, selected.operationRef);
    expect(saved?.record.effects["bind-production-runtime"]).toBe("pending");
    expect(
      await f.handler.observe(
        { ...ctx, callId: "later-read" },
        selected.operationRef,
        selected.planDigest,
      ),
    ).toMatchObject({ effect: "bind-production-runtime", status: "reconciliation-required" });
    expect(f.ports.observe).not.toHaveBeenCalled();
    f.ports.reconcileEffect = vi.fn().mockResolvedValue("unknown");
    expect(await f.handler.release(ctx, selected.operationRef, selected.planDigest)).toMatchObject({
      status: "reconciliation-required",
    });
    expect(f.ports.applyEffect).toHaveBeenCalledTimes(1);
  });
  it("preserves a per-key accepted environment ID across a failed outer effect", async () => {
    const f = fixture();
    const ctx = invocation();
    const selected = await f.handler.plan(ctx, plan.selection.appId);
    let bindingWrites = 0;
    const normalApply = f.ports.applyEffect;
    f.ports.applyEffect = async (context) => {
      if (context.effect === "bind-production-runtime") {
        const claimed = await context.bindings.claim("INVOICE_APP_DATABASE_URL");
        expect(claimed.state).toBe("pending");
        bindingWrites += 1;
        await context.bindings.recordAccepted("INVOICE_APP_DATABASE_URL", "env-accepted");
        throw new Error("interrupted after receipt");
      }
      await normalApply(context);
    };
    await expect(
      f.handler.release(ctx, selected.operationRef, selected.planDigest),
    ).rejects.toThrow("interrupted after receipt");
    const saved = await f.store.read(authority, selected.operationRef);
    expect(saved?.record.bindings.INVOICE_APP_DATABASE_URL).toEqual({
      acceptedEnvId: "env-accepted",
      state: "pending",
    });
    const normalReconcile = f.ports.reconcileEffect;
    f.ports.reconcileEffect = async (context) => {
      if (context.effect === "bind-production-runtime") {
        expect(context.priorPhase).toBe("pending");
        const bindings = await context.bindings.read();
        expect(bindings.INVOICE_APP_DATABASE_URL.acceptedEnvId).toBe("env-accepted");
        await context.bindings.recordVerified("INVOICE_APP_DATABASE_URL");
        return "applied";
      }
      return await normalReconcile(context);
    };
    expect(await f.handler.release(ctx, selected.operationRef, selected.planDigest)).toMatchObject({
      status: "ready",
    });
    expect(bindingWrites).toBe(1);
    expect(f.writes).toEqual(["publish-release-source"]);
  });

  it("requires fresh current-call approval and current owner before dispatch", async () => {
    const f = fixture();
    const ctx = invocation();
    const selected = await f.handler.plan(ctx, plan.selection.appId);
    f.ports.assertApproved = vi.fn().mockRejectedValue(new Error("approval pending"));
    await expect(
      f.handler.release(ctx, selected.operationRef, selected.planDigest),
    ).rejects.toThrow("approval pending");
    expect(f.writes).toEqual([]);
    await expect(
      f.handler.release(
        { ...ctx, authority: { ...authority, ownerUserId: "foreign" } },
        selected.operationRef,
        selected.planDigest,
      ),
    ).rejects.toThrow("unavailable");
    await expect(f.handler.release(ctx, selected.operationRef, "f".repeat(64))).rejects.toThrow(
      "unavailable",
    );
  });
  it("stops after binding if authorization changes before publication", async () => {
    const f = fixture();
    const ctx = invocation();
    const selected = await f.handler.plan(ctx, plan.selection.appId);
    f.ports.assertAuthorized = vi.fn(async () => {
      if (f.applied.has("bind-production-runtime")) {
        throw new Error("revoked");
      }
    });
    await expect(
      f.handler.release(ctx, selected.operationRef, selected.planDigest),
    ).rejects.toThrow("revoked");
    expect(f.writes).toEqual(["bind-production-runtime"]);
  });
  it("rejects wrong provider active-domain observations and cancelled calls", async () => {
    const f = fixture();
    const ctx = invocation();
    const selected = await f.handler.plan(ctx, plan.selection.appId);
    f.ports.observe = vi.fn().mockResolvedValue({
      deploymentId: "foreign",
      environment: "production",
      projectId: "foreign",
      publicOrigin: plan.publicOrigin,
      releaseId: plan.runtime.releaseId,
      status: "ready",
    });
    await expect(
      f.handler.release(ctx, selected.operationRef, selected.planDigest),
    ).rejects.toThrow("unavailable");
    const controller = new AbortController();
    controller.abort();
    await expect(
      f.handler.release(
        { ...ctx, signal: controller.signal },
        selected.operationRef,
        selected.planDigest,
      ),
    ).rejects.toThrow();
  });
  it("freezes public exposure, both effects and runtime key hashes in the approved intent", () => {
    expect(
      publicReleasePlanDigest({
        ...plan,
        environment: [{ key: "INVOICE_APP_DATABASE_URL", sha256: "f".repeat(64) }],
      }),
    ).not.toBe(publicReleasePlanDigest(plan));
    expect(
      publicReleasePlanSchema.safeParse({
        ...plan,
        runtime: { ...plan.runtime, syntheticOnly: false },
      }).success,
    ).toBe(false);
    expect(
      publicReleasePlanSchema.safeParse({
        ...plan,
        environment: [...plan.environment, plan.environment[0]],
      }).success,
    ).toBe(false);
  });
});

it("records observation failures without changing completed effects or claiming readiness", async () => {
  const f = fixture();
  vi.mocked(f.ports.observe).mockRejectedValue(
    new PublicReleaseProviderError({ code: "forbidden", statusCode: 403 }),
  );
  const ctx = invocation();
  const selected = await f.handler.plan(ctx, plan.selection.appId);
  await expect(f.handler.release(ctx, selected.operationRef, selected.planDigest)).rejects.toThrow(
    "public_release_provider_rejected",
  );
  const row = await f.store.read(authority, selected.operationRef);
  expect(row?.record.lastProviderFailure).toEqual({
    diagnostic: { code: "forbidden", statusCode: 403 },
    phase: "observe-production",
  });
  expect(Object.values(row?.record.effects ?? {})).toEqual(["applied", "applied"]);
  expect(row?.record.observation).toBeUndefined();
});

it.each([
  [
    403,
    { message: "private-provider-body" },
    { code: "forbidden", provider: "github", requestRef: "ABCD:1234:AA00:1234", statusCode: 403 },
  ],
  [
    200,
    {
      data: null,
      errors: [{ message: "private-provider-body", path: ["private"], type: "FORBIDDEN" }],
    },
    { code: "FORBIDDEN", provider: "github", requestRef: "ABCD:1234:AA00:1234", statusCode: 200 },
  ],
  [
    200,
    {
      data: null,
      errors: [{ message: "private-provider-body", type: "private-unrecognized-type" }],
    },
    { provider: "github", requestRef: "ABCD:1234:AA00:1234", statusCode: 200 },
  ],
])(
  "persists bounded actual GitHub denial metadata at HTTP%s without another branch dispatch",
  async (status, body, diagnostic) => {
    const f = fixture();
    let posts = 0;
    const github = createPublicReleaseGitHubProvider({
      assertCurrent: async () => {},
      fetch: async (resource) => {
        const parsed = z
          .union([z.string(), z.instanceof(URL), z.instanceof(Request)])
          .parse(resource);
        const url = new URL(parsed instanceof Request ? parsed.url : String(parsed));
        if (url.pathname.endsWith("/graphql")) {
          posts += 1;
          return Response.json(body, {
            headers: {
              "set-cookie": "private-cookie",
              "x-github-request-id": "ABCD:1234:AA00:1234",
            },
            status,
          });
        }
        if (url.pathname.startsWith("/repositories/")) {
          return Response.json({
            description: `Created by Autograph App Builder request ${plan.source.deliveryScope.provisioningRequestId}`,
            id: plan.source.repositoryId,
            name: "app",
            node_id: "repository-node",
            owner: { login: "owner" },
          });
        }
        if (decodeURIComponent(url.pathname).endsWith("/git/ref/heads/main")) {
          return Response.json({
            object: { sha: plan.source.expectedProductionSha, type: "commit" },
          });
        }
        if (decodeURIComponent(url.pathname).endsWith("/git/ref/heads/builder/app")) {
          return Response.json({ object: { sha: plan.source.sourceSha, type: "commit" } });
        }
        throw new Error("Unexpected request");
      },
      readCredential: async () => ({
        installationId: plan.source.installationId,
        repositoryId: plan.source.repositoryId,
        token: "private-test-token",
      }),
    });
    const apply = f.ports.applyEffect;
    const reconcile = f.ports.reconcileEffect;
    f.ports.applyEffect = async (context) => {
      await (context.effect === "publish-release-source"
        ? github.publish(context)
        : apply(context));
    };
    f.ports.reconcileEffect = async (context) =>
      context.effect === "publish-release-source"
        ? await github.reconcile(context)
        : await reconcile(context);
    const ctx = invocation();
    const selected = await f.handler.plan(ctx, plan.selection.appId);
    await expect(
      f.handler.release(ctx, selected.operationRef, selected.planDigest),
    ).rejects.toThrow("public_release_provider_rejected");
    const row = await f.store.read(authority, selected.operationRef);
    expect(row?.record.lastProviderFailure).toEqual({
      diagnostic,
      phase: "publish-release-source",
    });
    expect(row?.record.effects).toEqual({
      "bind-production-runtime": "applied",
      "publish-release-source": "pending",
    });
    expect(JSON.stringify(row)).not.toContain("private-");
    expect(await f.handler.release(ctx, selected.operationRef, selected.planDigest)).toMatchObject({
      status: "reconciliation-required",
    });
    expect(posts).toBe(1);
  },
);
