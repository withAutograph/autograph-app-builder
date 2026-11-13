/* oxlint-disable anti-slop/no-module-mocking -- Control the existing GitHub effect step and canonical client acquisition while keeping the workflow, serialized protected read and public progress projection real. */
/* oxlint-disable sonarjs/no-internal-api-use -- Direct saved-session tool calls run in an installed Eve context. */
import { beforeEach, expect, it, vi } from "vitest";
import type { ToolContext, WorkflowToolContext } from "eve/tools";
import { z } from "zod";
import type { GitHubPrDeliveryApproval } from "./github-pr-delivery-approval";
import type { OperatorOwnerContext } from "../provisioning/hosted-operator-contract";
import type { RepositoryProductionNativeStatus } from "../provisioning/repository-production-native-status-contract";
import { createRepositoryProductionClient } from "./repository-production-client";
import { readLiveMergedAppProduction } from "./app-production-observation";
import finishDelivery from "../../agent/tools/finish-github-pr-delivery";
import observeProduction from "../../agent/tools/observe-app-production";
import { HostedOperatorError } from "../provisioning/hosted-operator-contract";
import { projectInstalledEveEvent, toPublicEvent } from "../eve/public-events";
import {
  ContextContainer,
  contextStorage,
} from "../../node_modules/eve/dist/src/context/container.js";

const mocks = vi.hoisted(() => ({
  continueDelivery: vi.fn(),
  readAuthority: vi.fn(),
  clientForContext: vi.fn(),
  githubRuntime: vi.fn(),
  inspectPublishedPullRequest: vi.fn(),
  inspectReconciliationHead: vi.fn(),
  reviewedSubject: vi.fn(),
  sleep: vi.fn(),
}));
vi.mock("workflow", () => ({ sleep: mocks.sleep }));
vi.mock(import("./github-pr-delivery-step"), async (importOriginal) => ({
  ...(await importOriginal()),
  approveGitHubPrDelivery: vi.fn(),
  continueGitHubPrDelivery: mocks.continueDelivery,
}));
vi.mock("./github-pr-delivery-authority", () => ({
  readGitHubPrDeliveryAuthority: mocks.readAuthority,
}));
vi.mock("./deployment-github-publication-runtime", () => ({
  githubPublicationRuntimeForSession: mocks.githubRuntime,
}));
vi.mock("./github-pr-delivery-subject", () => ({
  resolveGitHubPrDeliverySubject: mocks.reviewedSubject,
}));
vi.mock(import("./repository-production-client"), async (importOriginal) => ({
  ...(await importOriginal()),
  repositoryProductionClientForContext: mocks.clientForContext,
}));

const appId = "journal-free-app";
const origin = "https://apps.example.com";
const appUrl = `${origin}/${appId}`;
const mergeCommitSha = "c".repeat(40);
const approval: GitHubPrDeliveryApproval = {
  baseBranch: "main",
  headSha: "a".repeat(40),
  name: "app-repository",
  owner: "controlled-owner",
  repositoryId: "100",
  pullRequestNumber: 42,
  proposalDigest: "b".repeat(64),
};
const nativeProductionTarget = {
  appId,
  repositoryId: approval.repositoryId,
  repositoryFullName: `${approval.owner}/${approval.name}`,
};
const authority = {
  issuer: "https://builder.example.com",
  audience: "builder",
  ownerUserId: "creator",
  workspaceId: "workspace",
};
const ownerContext: OperatorOwnerContext = {
  kind: "direct",
  adapterGeneration: 1,
  adapterSessionId: "saved-session",
  sessionId: "saved-session",
  authority,
  principal: { ...authority, scopes: ["sessions:read"] },
};
const unavailable = (): never => {
  throw new Error("Unexpected non-read operation");
};
const context = (controller = new AbortController()): WorkflowToolContext & ToolContext => ({
  abortSignal: controller.signal,
  callId: "approved-merge-call",
  toolName: "finish-github-pr-delivery",
  getToken: unavailable,
  getSandbox: unavailable,
  requireAuth: unavailable,
  ask: unavailable,
  agent: unavailable,
  agents: {},
  session: {
    id: "saved-session",
    auth: { current: null, initiator: null },
    turn: { id: "saved-turn", sequence: 2 },
  },
});
const observeSaved = async () =>
  await contextStorage.run(
    new ContextContainer(),
    async () => await observeProduction.execute({ appId }, context()),
  );
const observed = (
  status: "pending" | "available",
  requestedRevision: RepositoryProductionNativeStatus["requestedRevision"] = "unassessed",
): RepositoryProductionNativeStatus => ({
  version: 1,
  appId,
  observedAt: "2026-11-10T16:00:00Z",
  status,
  destination: {
    repositoryId: nativeProductionTarget.repositoryId,
    repositoryFullName: nativeProductionTarget.repositoryFullName,
  },
  deployment: { state: status === "available" ? "active" : "not-observed" },
  app:
    status === "available" ? { state: "sign-in-required", url: appUrl } : { state: "not-observed" },
  requestedRevision,
});
const workflowIterator = (execution: ReturnType<typeof finishDelivery.execute>) => {
  if (!(Symbol.asyncIterator in execution)) {
    throw new Error("Missing durable delivery generator");
  }
  const iterator: AsyncIterator<unknown, unknown> = execution[Symbol.asyncIterator]();
  return iterator;
};
const settle = async (iterator: AsyncIterator<unknown, unknown>) => {
  let item = await iterator.next();
  while (item.done !== true) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Drive the same workflow to its terminal result.
    item = await iterator.next();
  }
  return item.value;
};
const finish = async (ctx = context()) =>
  await settle(workflowIterator(finishDelivery.execute(approval, ctx)));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.sleep.mockResolvedValue(null);
  mocks.readAuthority.mockResolvedValue({ subject: { appId }, requirements: [] });
  mocks.githubRuntime.mockResolvedValue({
    inspectPublishedPullRequest: mocks.inspectPublishedPullRequest,
    inspectPublishedReconciliationHead: mocks.inspectReconciliationHead,
  });
  mocks.continueDelivery.mockResolvedValue({
    status: "merged",
    mergeCommitSha,
    nativeProductionTarget,
  });
});

it("installs the approved addition only after the provider activates the exact merged revision", async () => {
  const approvalReference = { appId, operationRef: "same-existing-app-setup" };
  const mergeIntentDigest = "d".repeat(64);
  mocks.continueDelivery.mockResolvedValue({
    status: "merged",
    mergeCommitSha,
    nativeProductionTarget,
    schemaActivation: { deliveryCallId: "approved-merge-call", mergeIntentDigest },
  });
  mocks.readAuthority.mockResolvedValue({
    subject: { appId },
    requirements: [],
    productionSchemaApprovalCallId: "single-build-approval",
  });
  const nativeStatus = vi
    .fn()
    // A signed-out response can appear live before the protected provider proof is available.
    .mockResolvedValueOnce(observed("available", "live"))
    .mockResolvedValueOnce({
      ...observed("pending", "awaiting-activation"),
      deployment: { state: "active", requestedRevisionActive: true },
    })
    .mockResolvedValueOnce({
      ...observed("pending", "awaiting-activation"),
      deployment: { state: "active", requestedRevisionActive: true },
    })
    .mockResolvedValueOnce(observed("available", "live"));
  const plan = vi.fn().mockResolvedValue({ approvalReference });
  const prepare = vi
    .fn()
    .mockRejectedValueOnce(new Error("Setup response unavailable"))
    .mockResolvedValueOnce({ setup: { state: "ready" } });
  mocks.clientForContext.mockResolvedValue({ nativeStatus, plan, prepare });
  mocks.sleep.mockImplementationOnce(async () => {
    expect(prepare).not.toHaveBeenCalled();
    await Promise.resolve();
  });

  await expect(finish()).resolves.toMatchObject({
    status: "merged",
    nativeProduction: { requestedRevision: "live", app: { url: appUrl } },
  });
  expect(nativeStatus).toHaveBeenNthCalledWith(1, appId, mergeCommitSha, true);
  expect(nativeStatus).toHaveBeenNthCalledWith(2, appId, mergeCommitSha, true);
  expect(prepare).toHaveBeenCalledTimes(2);
  expect(prepare).toHaveBeenLastCalledWith(approvalReference, "single-build-approval", {
    deliveryCallId: "approved-merge-call",
    mergeIntentDigest,
    mergeSha: mergeCommitSha,
    reviewedHeadSha: approval.headSha,
  });
  expect(nativeStatus).toHaveBeenNthCalledWith(4, appId, mergeCommitSha);
  expect(mocks.continueDelivery).toHaveBeenCalledTimes(1);
});

it("continues an actual merged workflow through protected native reads without merging again", async () => {
  // The successful merge already retained its app. No current Build/review projection survives.
  mocks.readAuthority.mockRejectedValue(new Error("Old private Build projection is absent"));
  const responses = [
    observed("pending", "awaiting-activation"),
    observed("available", "awaiting-activation"),
    observed("available", "live"),
  ];
  const requests: { method: string | undefined; input: unknown }[] = [];
  const client = createRepositoryProductionClient({
    endpoint: "https://operator.example.com",
    ownerContext,
    callId: "approved-merge-call",
    signal: new AbortController().signal,
    workloadToken: async () => await Promise.resolve("controlled-workload"),
    fetch: async (_url, init) => {
      const input: unknown = JSON.parse(z.string().parse(init?.body));
      requests.push({ method: init?.method, input });
      const response = responses.shift();
      if (response === undefined) {
        throw new Error("Unexpected repeated native read");
      }
      return await Promise.resolve(Response.json(response));
    },
  });
  mocks.clientForContext.mockResolvedValue(client);
  const workflow = workflowIterator(finishDelivery.execute(approval, context()));
  const merged = await workflow.next();
  expect(merged).toEqual({ done: false, value: { status: "merged", mergeCommitSha } });
  expect(requests).toHaveLength(0);
  const pending = projectInstalledEveEvent(
    {
      type: "action.partial",
      meta: { at: "2026-11-10T16:00:00Z", id: "native-observation-started" },
      data: {
        result: {
          kind: "tool-result",
          toolName: "finish-github-pr-delivery",
          callId: "approved-merge-call",
          output: z.json().parse(merged.value),
        },
        sequence: 1,
        stepIndex: 1,
        turnId: "saved-turn",
      },
    },
    1,
  );
  expect(pending).toMatchObject([{ state: "started", type: "progress" }]);
  const result = await settle(workflow);
  expect(result).toMatchObject({
    status: "merged",
    mergeCommitSha,
    nativeProduction: {
      status: "available",
      app: { url: appUrl },
      requestedRevision: "live",
    },
  });
  const events = projectInstalledEveEvent(
    {
      type: "action.result",
      meta: { at: "2026-11-10T16:00:15Z", id: "native-observation-completed" },
      data: {
        status: "completed",
        result: {
          kind: "tool-result",
          toolName: "finish-github-pr-delivery",
          callId: "approved-merge-call",
          output: z.json().parse(result),
        },
        sequence: 2,
        stepIndex: 1,
        turnId: "saved-turn",
      },
    },
    2,
  ).map(toPublicEvent);
  expect(events).toMatchObject([
    { state: "completed", type: "progress" },
    { type: "assistant_message" },
  ]);
  const message = events.find((event) => event?.type === "assistant_message");
  expect(message?.text).toContain(appUrl);
  expect(requests).toHaveLength(3);
  for (const request of requests) {
    expect(request).toEqual({
      method: "POST",
      input: {
        version: 1,
        action: "native-status",
        appId,
        expectedMergeSha: mergeCommitSha,
        sessionId: ownerContext.sessionId,
        ownerContext,
      },
    });
  }
  expect(mocks.continueDelivery).toHaveBeenCalledOnce();
  expect(mocks.readAuthority).not.toHaveBeenCalled();
  expect(mocks.sleep).toHaveBeenCalledTimes(2);
});

it.each(["pending", "available"] as const)(
  "returns %s availability for a saved app without waiting for a merge",
  async (status) => {
    mocks.readAuthority.mockRejectedValue(new Error("No old Ready or Build state"));
    const requests: unknown[] = [];
    mocks.clientForContext.mockResolvedValue(
      createRepositoryProductionClient({
        endpoint: "https://operator.example.com",
        ownerContext,
        callId: "saved-app-read",
        signal: new AbortController().signal,
        workloadToken: async () => await Promise.resolve("controlled-workload"),
        fetch: async (_url, init) => {
          const request: unknown = JSON.parse(z.string().parse(init?.body));
          requests.push(request);
          return await Promise.resolve(
            Response.json(observed(requests.length === 1 ? status : "available")),
          );
        },
      }),
    );
    const result = await observeSaved();
    expect(result).toEqual(observed(status));
    expect(requests).toHaveLength(1);
    expect(requests[0]).not.toHaveProperty("expectedMergeSha");
    expect(mocks.continueDelivery).not.toHaveBeenCalled();
    expect(mocks.readAuthority).not.toHaveBeenCalled();
    expect(mocks.sleep).not.toHaveBeenCalled();
  },
);

it("reads the exact historical reconciled merge without replaying Ready or merge", async () => {
  const reconciliation = { digest: "d".repeat(64) };
  mocks.reviewedSubject.mockReturnValue({
    appId,
    proposalDigest: approval.proposalDigest,
    reconciliation,
    installationId: "101",
  });
  mocks.inspectReconciliationHead.mockResolvedValue(approval.headSha);
  mocks.inspectPublishedPullRequest.mockResolvedValue({
    state: "merged",
    mergeCommitSha,
    reviewedRevision: true,
    reviewedTarget: approval,
  });
  const nativeStatus = vi.fn().mockResolvedValue(observed("available", "live"));
  mocks.clientForContext.mockResolvedValue({ nativeStatus });

  await expect(observeSaved()).resolves.toMatchObject({
    requestedRevision: "live",
    app: { url: appUrl },
  });
  expect(mocks.inspectReconciliationHead).toHaveBeenCalledWith(
    approval.proposalDigest,
    reconciliation,
  );
  expect(mocks.inspectPublishedPullRequest).toHaveBeenCalledWith(
    approval.proposalDigest,
    approval.headSha,
  );
  expect(nativeStatus).toHaveBeenCalledExactlyOnceWith(appId, mergeCommitSha);
  expect(mocks.continueDelivery).not.toHaveBeenCalled();
  expect(mocks.readAuthority).not.toHaveBeenCalled();
  expect(mocks.sleep).not.toHaveBeenCalled();
});

it("confirms the same protected merged app only with schema-aware readback", async () => {
  const schemaGrantDigest = "d".repeat(64);
  const live = observed("available", "live");
  const nativeStatus = vi
    .fn()
    .mockResolvedValueOnce(live)
    .mockResolvedValueOnce(observed("available", "awaiting-activation"))
    .mockResolvedValueOnce({ ...live, destination: { ...live.destination, repositoryId: "101" } })
    .mockResolvedValueOnce({
      ...live,
      deployment: { ...live.deployment, requestedRevisionActive: true },
    });
  const prepare = vi.fn();
  mocks.clientForContext.mockResolvedValue({ nativeStatus, prepare });
  const ctx = context();
  const read = async () =>
    await readLiveMergedAppProduction(
      nativeProductionTarget,
      ctx,
      mergeCommitSha,
      schemaGrantDigest,
    );

  await expect(read()).resolves.toEqual(live);
  await expect(read()).resolves.toBeUndefined();
  await expect(read()).resolves.toBeUndefined();
  await expect(read()).resolves.toBeUndefined();
  expect(nativeStatus.mock.calls).toEqual(
    Array.from({ length: 4 }, () => [appId, mergeCommitSha, undefined, schemaGrantDigest]),
  );
  expect(prepare).not.toHaveBeenCalled();
});

it.each(["open", "unreviewed", "moved", "foreign-app", "read-failed"] as const)(
  "keeps independent app availability when historical delivery is %s",
  async (failure) => {
    const subject = {
      appId: failure === "foreign-app" ? "other-app" : appId,
      proposalDigest: approval.proposalDigest,
    };
    mocks.reviewedSubject.mockReturnValue(subject);
    if (failure === "moved") {
      mocks.reviewedSubject.mockReturnValueOnce(subject).mockReturnValue({
        ...subject,
        proposalDigest: "d".repeat(64),
      });
    }
    mocks.inspectPublishedPullRequest.mockResolvedValue({
      state: failure === "open" ? "open" : "merged",
      mergeCommitSha,
      reviewedRevision: failure !== "unreviewed",
      reviewedTarget: approval,
    });
    if (failure === "read-failed") {
      mocks.inspectPublishedPullRequest.mockRejectedValue(new Error("provider read failed"));
    }
    const nativeStatus = vi.fn().mockResolvedValue(observed("available"));
    mocks.clientForContext.mockResolvedValue({ nativeStatus });

    await expect(observeSaved()).resolves.toMatchObject({
      requestedRevision: "unassessed",
      app: { url: appUrl },
    });
    expect(nativeStatus).toHaveBeenCalledOnce();
    expect(nativeStatus.mock.calls[0]?.[0]).toBe(appId);
    expect(nativeStatus.mock.calls[0]?.[1]).toBeUndefined();
    expect(mocks.continueDelivery).not.toHaveBeenCalled();
  },
);

it("returns merged with the available app link when activation remains pending beyond the observation window", async () => {
  const nativeStatus = vi.fn().mockResolvedValue(observed("available", "awaiting-activation"));
  mocks.clientForContext.mockResolvedValue({ nativeStatus });

  await expect(finish()).resolves.toMatchObject({
    status: "merged",
    mergeCommitSha,
    nativeProduction: { requestedRevision: "awaiting-activation", app: { url: appUrl } },
  });
  expect(mocks.sleep).toHaveBeenCalledTimes(80);
  expect(mocks.continueDelivery).toHaveBeenCalledOnce();
});

it("keeps the known app link and merge after a transient native provider read failure", async () => {
  const nativeStatus = vi
    .fn()
    .mockResolvedValueOnce(observed("available", "awaiting-activation"))
    .mockRejectedValueOnce(new Error("provider unavailable"));
  mocks.clientForContext.mockResolvedValue({ nativeStatus });

  await expect(finish()).resolves.toMatchObject({
    status: "merged",
    mergeCommitSha,
    nativeProduction: { status: "service-unavailable", app: { url: appUrl } },
  });
  expect(mocks.continueDelivery).toHaveBeenCalledOnce();
});

it.each(["repositoryId", "repositoryFullName"] as const)(
  "does not present another %s as the approved merged delivery",
  async (field) => {
    const status = observed("available");
    if (status.destination === undefined) {
      throw new Error("Missing controlled destination");
    }
    status.destination[field] = field === "repositoryId" ? "999" : "other/repository";
    mocks.clientForContext.mockResolvedValue(
      createRepositoryProductionClient({
        endpoint: "https://operator.example.com",
        ownerContext,
        callId: "saved-app-read",
        signal: new AbortController().signal,
        workloadToken: async () => await Promise.resolve("controlled-workload"),
        fetch: async () => await Promise.resolve(Response.json(status)),
      }),
    );
    const result = await finish();
    expect(result).toMatchObject({
      status: "merged",
      mergeCommitSha,
      nativeProduction: { status: "monitoring-stopped" },
    });
    expect(JSON.stringify(result)).not.toContain(appUrl);
    expect(mocks.continueDelivery).toHaveBeenCalledOnce();
    expect(mocks.sleep).not.toHaveBeenCalled();
  },
);

it.each(["foreign-app", "revoked"] as const)(
  "stops only monitoring after %s without repeating a completed merge",
  async (failure) => {
    mocks.clientForContext.mockResolvedValue(
      createRepositoryProductionClient({
        endpoint: "https://operator.example.com",
        ownerContext,
        callId: "saved-app-read",
        signal: new AbortController().signal,
        workloadToken: async () => await Promise.resolve("controlled-workload"),
        fetch: async () =>
          await Promise.resolve(
            failure === "revoked"
              ? Response.json(
                  { code: "authorization_required", privateCredential: "never-expose" },
                  { status: 403 },
                )
              : Response.json({ ...observed("available"), appId: "other-app" }),
          ),
      }),
    );
    const result = await finish();
    expect(result).toMatchObject({
      status: "merged",
      mergeCommitSha,
      nativeProduction: { status: "monitoring-stopped" },
    });
    expect(JSON.stringify(result)).not.toContain("never-expose");
    expect(JSON.stringify(result)).not.toContain(appUrl);
    expect(mocks.continueDelivery).toHaveBeenCalledOnce();
    expect(mocks.sleep).not.toHaveBeenCalled();
  },
);

it("keeps a missing deployment service as Builder-managed status after merge", async () => {
  mocks.clientForContext.mockRejectedValue(new Error("private operator configuration"));
  const result = await finish();
  expect(result).toMatchObject({
    status: "merged",
    nativeProduction: {
      status: "service-unavailable",
      serviceIssue: "configuration",
      requestedRevision: "unassessed",
    },
  });
  expect(JSON.stringify(result)).not.toContain("private operator configuration");
  expect(mocks.continueDelivery).toHaveBeenCalledOnce();
  expect(mocks.sleep).not.toHaveBeenCalled();
});

it("stops saved monitoring after canonical ownership is revoked", async () => {
  mocks.clientForContext.mockRejectedValue(new HostedOperatorError("authorization_required"));
  const result = await observeSaved();
  expect(result).toEqual({ status: "monitoring-stopped", requestedRevision: "unassessed" });
  expect(mocks.sleep).not.toHaveBeenCalled();
});

it("honors Stop during a durable pending wait without another read or merge", async () => {
  const controller = new AbortController();
  const stopped = new Error("Native session stopped");
  let reads = 0;
  mocks.clientForContext.mockResolvedValue(
    createRepositoryProductionClient({
      endpoint: "https://operator.example.com",
      ownerContext,
      callId: "saved-app-read",
      signal: controller.signal,
      workloadToken: async () => await Promise.resolve("controlled-workload"),
      fetch: async () => {
        reads += 1;
        return await Promise.resolve(Response.json(observed("pending")));
      },
    }),
  );
  mocks.sleep.mockImplementation(async () => {
    controller.abort(stopped);
    await Promise.resolve();
  });
  await expect(finish(context(controller))).rejects.toBe(stopped);
  expect(reads).toBe(1);
  expect(mocks.continueDelivery).toHaveBeenCalledOnce();
});

it("never reads native availability before the approved merge actually succeeds", async () => {
  mocks.continueDelivery.mockResolvedValue({ status: "merge-unconfirmed" });
  await finish();
  expect(mocks.clientForContext).not.toHaveBeenCalled();
  expect(mocks.readAuthority).not.toHaveBeenCalled();
  expect(mocks.sleep).not.toHaveBeenCalled();
});

it("keeps the normal GitHub-only merge result without attempting an unrelated native read", async () => {
  mocks.continueDelivery.mockResolvedValue({ status: "merged", mergeCommitSha });
  expect(await finish()).toEqual({ status: "merged", mergeCommitSha });
  expect(mocks.clientForContext).not.toHaveBeenCalled();
  expect(mocks.sleep).not.toHaveBeenCalled();
});
