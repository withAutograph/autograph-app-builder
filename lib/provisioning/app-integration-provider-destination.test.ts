/* oxlint-disable eslint/require-await -- Controlled asynchronous custody/provider ports exercise genuine worker sequencing without network effects. */
import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { createAppIntegrationProviderDestinationWorker } from "./app-integration-provider-destination";
import { integrationCapabilityV2PlanInput } from "./app-integration-capability-v2-test-fixture";
import {
  appIntegrationCapabilityPlanSchema,
  appIntegrationCapabilityPlanDigest,
  appIntegrationCapabilityOperationRef,
} from "./app-integration-capability-contract";
import type { IntegrationCapabilityReceipt } from "./app-integration-capability-contract";
import type {
  IntegrationPrivateJson,
  IntegrationPrivateScope,
  createAppIntegrationPrivateCustody,
} from "./app-integration-private-custody";
import type { AppIntegrationCapabilityEffectContext } from "./app-integration-capability-ports";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const fixture = () => {
  const plan = appIntegrationCapabilityPlanSchema.parse(integrationCapabilityV2PlanInput());
  const appScope = {
    authority: plan.authority,
    appId: plan.selection.appId,
    projectId: plan.project.projectId,
    provisioningRequestId: plan.project.provisioningRequestId,
    provisioningDigest: plan.project.provisioningDigest,
    resourceProfileId: plan.control.resourceProfileId,
    controlResource: plan.control.database,
    controlNeon: plan.control.neon,
  };
  type Row = { reference: string; sha256: string; value: IntegrationPrivateJson };
  const values = new Map<string, Row>();
  const key = (scope: IntegrationPrivateScope) => JSON.stringify(scope);
  const custody: Pick<ReturnType<typeof createAppIntegrationPrivateCustody>, "read" | "reserve"> = {
    read: async (scope) => values.get(key(scope)),
    reserve: async (scope, prepare) => {
      const existing = values.get(key(scope));
      if (existing !== undefined) {
        return existing;
      }
      const hash = sha(key(scope)),
        value = prepare(),
        row = {
          reference: `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`,
          sha256: sha(JSON.stringify(value)),
          value,
        };
      values.set(key(scope), row);
      return row;
    },
  };
  let remote:
    | {
        id: string;
        name: string;
        type: "webhook";
        metadata: { url: string };
        secrets: { webhookSigningKey: string };
      }
    | undefined;
  let losePost = false;
  const fetcher = vi.fn<typeof fetch>(async (url, options) => {
    const parsed = new URL(url instanceof Request ? url.url : url);
    expect(parsed.origin).toBe("https://api.withampersand.com");
    if (options?.method === "POST") {
      const body = z
        .object({
          name: z.string(),
          type: z.literal("webhook"),
          metadata: z.object({ url: z.url() }),
        })
        .parse(JSON.parse(z.string().parse(options.body)));
      remote = {
        id: "actual-provider-destination",
        ...body,
        secrets: { webhookSigningKey: "whsec_c3ludGhldGljLWtleS1mb3ItdGVzdHM=" },
      };
      if (losePost) {
        throw new Error("connection_closed");
      }
      return Response.json(remote);
    }
    expect(parsed.searchParams.get("includeSecrets")).toBe("true");
    return remote === undefined ? new Response(null, { status: 404 }) : Response.json(remote);
  });
  let receipt: IntegrationCapabilityReceipt | undefined;
  const assertCurrent = vi.fn(async () => {});
  const context: AppIntegrationCapabilityEffectContext = {
    plan,
    invocation: {
      authority: plan.authority,
      sessionId: plan.selection.sessionId,
      callId: "fresh-provider-approval",
      signal: new AbortController().signal,
    },
    operationRef: appIntegrationCapabilityOperationRef(plan),
    planDigest: appIntegrationCapabilityPlanDigest(plan),
    effect: "prepare-provider-destination",
    priorPhase: "idle",
    fenceGeneration: 1,
    attemptGeneration: 1,
    assertCurrent,
    checkpoint: {
      read: async () => receipt,
      recordAccepted: async (value) => {
        receipt = value;
      },
    },
  };
  const worker = createAppIntegrationProviderDestinationWorker({
    custody,
    appScope,
    readApiKey: async (current) => {
      await current();
      return "isolated-provider-key";
    },
    fetch: fetcher,
  });
  const target = {
    projectId: plan.provider.projectId,
    name: "isolated-reads",
    origin: plan.publicOrigin,
    path: `/${plan.selection.appId}/api/integrations/quickbooks`,
    signal: context.invocation.signal,
    assertCurrent,
  };
  const posts = () => fetcher.mock.calls.filter(([, options]) => options?.method === "POST").length;
  return {
    worker,
    context,
    target,
    posts,
    values,
    fetcher,
    setLost: () => {
      losePost = true;
    },
    foreign: () => {
      remote = {
        id: "foreign",
        name: target.name,
        type: "webhook",
        metadata: { url: "https://foreign.example/read" },
        secrets: { webhookSigningKey: "foreign-key" },
      };
    },
    rotate: () => {
      if (remote !== undefined) {
        remote.secrets.webhookSigningKey = "different-provider-key";
      }
    },
    receipt: () => receipt,
  };
};
it("creates once, seals accepted identity and key before ACK, and reads back the exact owned destination", async () => {
  const f = fixture();
  expect(await f.worker.readOwnedDestination(f.target)).toBeUndefined();
  const receipt = await f.worker.execute(f.context);
  expect(receipt.effect).toBe("prepare-provider-destination");
  expect(f.posts()).toBe(1);
  expect(f.values.size).toBe(2);
  expect(await f.worker.reconcile({ ...f.context, priorPhase: "pending" })).toEqual({
    status: "applied",
    receipt,
  });
  expect(f.receipt()).toEqual(receipt);
  expect(JSON.stringify(receipt)).not.toContain("whsec_");
});
it("does not adopt a same-named foreign destination or mutate its URL", async () => {
  const f = fixture();
  f.foreign();
  await expect(f.worker.readOwnedDestination(f.target)).rejects.toThrow();
  await expect(f.worker.execute(f.context)).rejects.toThrow();
  expect(f.posts()).toBe(0);
  expect(f.values.size).toBe(0);
});
it("leaves lost POST acknowledgement unknown despite matching remote name and URL and never sends again", async () => {
  const f = fixture();
  f.setLost();
  await expect(f.worker.execute(f.context)).rejects.toThrow();
  expect(f.posts()).toBe(1);
  const pending = { ...f.context, priorPhase: "pending" as const };
  expect(await f.worker.reconcile(pending)).toEqual({ status: "unknown" });
  await expect(f.worker.execute(pending)).rejects.toThrow();
  expect(f.posts()).toBe(1);
  expect(f.values.size).toBe(0);
});
it("refuses a changed provider key without overwriting accepted custody", async () => {
  const f = fixture();
  await f.worker.execute(f.context);
  const before = JSON.stringify([...f.values]);
  f.rotate();
  expect(await f.worker.reconcile({ ...f.context, priorPhase: "pending" })).toEqual({
    status: "unknown",
  });
  expect(JSON.stringify([...f.values])).toBe(before);
  expect(f.posts()).toBe(1);
});
it("reuses only an owned independently verified destination explicitly frozen in fresh consent", async () => {
  const f = fixture();
  await f.worker.execute(f.context);
  const existing = await f.worker.readOwnedDestination(f.target);
  expect(existing).toBeDefined();
  const selected = appIntegrationCapabilityPlanSchema.parse({
    ...f.context.plan,
    selection: { ...f.context.plan.selection, sessionId: "new-current-session" },
  });
  const next = {
    ...f.context,
    plan: selected,
    operationRef: appIntegrationCapabilityOperationRef(selected),
    planDigest: appIntegrationCapabilityPlanDigest(selected),
  };
  await expect(f.worker.execute(next)).rejects.toThrow();
  const plan = appIntegrationCapabilityPlanSchema.parse({
    ...selected,
    providerDestination: { ...selected.providerDestination, existing },
  });
  const approved = {
    ...next,
    plan,
    operationRef: appIntegrationCapabilityOperationRef(plan),
    planDigest: appIntegrationCapabilityPlanDigest(plan),
  };
  await expect(f.worker.execute(approved)).resolves.toEqual(f.receipt());
  expect(f.posts()).toBe(1);
});
it("projects only safe HTTP diagnostics without retaining provider body or unsafe references", async () => {
  const f = fixture();
  f.fetcher.mockImplementation(async (_url, options) =>
    options?.method === "POST"
      ? Response.json(
          { message: "isolated-provider-key whsec_secret https://private.example" },
          { status: 403, headers: { "x-request-id": "request_403-safe" } },
        )
      : new Response(null, { status: 404 }),
  );
  await expect(f.worker.execute(f.context)).rejects.toMatchObject({
    message: "app_integration_provider_rejected",
    diagnostic: {
      provider: "ampersand",
      statusCode: 403,
      code: "forbidden",
      requestRef: "request_403-safe",
    },
  });
  expect(f.posts()).toBe(1);
  expect(await f.worker.reconcile({ ...f.context, priorPhase: "pending" })).toEqual({
    status: "unknown",
  });
  expect(f.posts()).toBe(1);
  expect(JSON.stringify([...f.values])).not.toContain("whsec_secret");
});
