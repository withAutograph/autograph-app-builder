/* oxlint-disable sonarjs/no-internal-api-use -- This regression deliberately exercises the patched pinned runtime coordinator. */
import type { SessionKey as RuntimeSessionKey } from "../../node_modules/eve/dist/src/context/keys";
import type {
  ContextContainer as RuntimeContextContainer,
  contextStorage as RuntimeContextStorage,
} from "../../node_modules/eve/dist/src/context/container";
import type { getApprovalAuditState as RuntimeApprovalAudit } from "../../node_modules/eve/dist/src/harness/approval-candidates";
import type { appendPendingInputBatch as RuntimeAppendPendingBatch } from "../../node_modules/eve/dist/src/harness/pending-input-batches";
import type { coordinateApprovalDelivery as RuntimeCoordinator } from "../../node_modules/eve/dist/src/harness/approval-delivery-coordinator";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import type { HarnessToolMap } from "../../node_modules/eve/dist/src/harness/types";
import type {
  ApprovalResponseContext,
  ApprovalResponseDecision,
} from "../../node_modules/eve/dist/src/approval/definition";
import { fileURLToPath, pathToFileURL } from "node:url";

interface CoordinatorModule {
  coordinateApprovalDelivery: typeof RuntimeCoordinator;
}
type CoordinatorInput = Parameters<CoordinatorModule["coordinateApprovalDelivery"]>[0] & {
  abortSignal?: AbortSignal;
};
let fixtureDirectory: string;
let coordinator: CoordinatorModule;
let batches: { appendPendingInputBatch: typeof RuntimeAppendPendingBatch };
let approvals: { getApprovalAuditState: typeof RuntimeApprovalAudit };
let contexts: {
  ContextContainer: typeof RuntimeContextContainer;
  contextStorage: typeof RuntimeContextStorage;
};
let keys: { SessionKey: typeof RuntimeSessionKey };

beforeAll(async () => {
  const source = fileURLToPath(new URL("../../node_modules/eve/", import.meta.url));
  fixtureDirectory = mkdtempSync(path.join(tmpdir(), "native-approval-coordinator-"));
  cpSync(path.join(source, "dist"), path.join(fixtureDirectory, "dist"), { recursive: true });
  cpSync(path.join(source, "package.json"), path.join(fixtureDirectory, "package.json"));
  symlinkSync(
    path.join(source, "node_modules"),
    path.join(fixtureDirectory, "node_modules"),
    "dir",
  );
  const patch = readFileSync(new URL("../../patches/eve@0.68.0.patch", import.meta.url), "utf-8");
  const section = patch
    .split("diff --git a/dist/src/harness/approval-delivery-coordinator.js")[1]
    ?.split("diff --git ")[0];
  const added = section
    ?.split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"));
  if (added === undefined || added.length === 0) {
    throw new Error("The coordinator package patch is missing.");
  }
  writeFileSync(
    path.join(fixtureDirectory, "dist/src/harness/approval-delivery-coordinator.js"),
    added.map((line) => line.slice(1)).join("\n"),
  );
  const internal = <Module>(name: string) =>
    vi.importActual<Module>(pathToFileURL(path.join(fixtureDirectory, `dist/src/${name}.js`)).href);
  [coordinator, batches, approvals, contexts, keys] = await Promise.all([
    internal<CoordinatorModule>("harness/approval-delivery-coordinator"),
    internal<typeof batches>("harness/pending-input-batches"),
    internal<typeof approvals>("harness/approval-candidates"),
    internal<typeof contexts>("context/container"),
    internal<typeof keys>("context/keys"),
  ]);
});
afterAll(() => {
  if (fixtureDirectory) {
    rmSync(fixtureDirectory, { recursive: true, force: true });
  }
});

const setup = async (
  authorize: () => Promise<ApprovalResponseDecision>,
  abortSignal?: AbortSignal,
) => {
  const actor = { authenticator: "fixture", principalId: "owner", principalType: "user" };
  const request = {
    kind: "tool-approval",
    requestId: "pending-request",
    prompt: "Approve target",
    action: {
      kind: "tool-call",
      toolName: "prepare-app-native-target",
      callId: "pending-call",
      input: { plan: "same-plan" },
    },
  };
  const initial = batches.appendPendingInputBatch({
    session: {
      sessionId: "session",
      state: {},
      history: [],
      agent: { dynamicModel: true, system: "", tools: [] },
      compaction: { recentWindowSize: 1, threshold: 1000 },
      continuationToken: "fixture",
    },
    requests: [request],
    responseAuthRequiredRequestIds: [request.requestId],
    responseMessages: [],
  });
  const context = new contexts.ContextContainer();
  context.set(keys.SessionKey, {
    sessionId: "session",
    auth: { current: actor, initiator: actor },
    turn: { id: "turn", sequence: 1 },
  });
  const authorizer = vi.fn(async (input: ApprovalResponseContext) => {
    expect(input.responder.principalId).toBe("owner");
    expect(input.request.requestId).toBe(request.requestId);
    return await authorize();
  });
  const tools: HarnessToolMap = new Map([
    [
      "prepare-app-native-target",
      {
        name: "prepare-app-native-target",
        description: "fixture",
        inputSchema: z.object({}),
        approval: { request: () => "user-approval", response: authorizer },
      },
    ],
  ]);
  const run = (input: CoordinatorInput) =>
    contexts.contextStorage.run(context, () => coordinator.coordinateApprovalDelivery(input));
  const ingested = await run({
    now: 1,
    session: initial,
    tools,
    abortSignal,
    stepInput: {
      attributedInputResponses: [
        { auth: actor, response: { requestId: request.requestId, optionId: "approve" } },
      ],
    },
  });
  expect(ingested.kind).toBe("continue-coordination");
  return {
    authorizer,
    session: ingested.session,
    run: () => run({ now: 2, session: ingested.session, tools, abortSignal }),
  };
};

describe("native approval coordinator recovery", () => {
  it("waits for the owner authorizer beyond ten seconds and settles its actual success", async () => {
    const authorization = Promise.withResolvers<ApprovalResponseDecision>();
    const f = await setup(() => authorization.promise);
    vi.useFakeTimers();
    try {
      const pending = f.run();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(f.authorizer).toHaveBeenCalledTimes(1);
      authorization.resolve({ status: "allowed" });
      const result = await pending;
      expect(approvals.getApprovalAuditState(result.session.state).settlements).toEqual([
        expect.objectContaining({ requestId: "pending-request", outcome: "allowed" }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
  it.each(["denied", "failure"])("keeps %s authorization fail-closed", async (mode) => {
    const f = await setup(() => {
      if (mode === "failure") {
        return Promise.reject(new Error("owner verification unavailable"));
      }
      return Promise.resolve({ status: "rejected", reason: "owner denied" });
    });
    const result = await f.run();
    expect(approvals.getApprovalAuditState(result.session.state).settlements).toHaveLength(0);
  });
  it("interrupts on actual cancellation and cannot settle a late authorizer success", async () => {
    const controller = new AbortController();
    const authorization = Promise.withResolvers<ApprovalResponseDecision>();
    const f = await setup(() => authorization.promise, controller.signal);
    const pending = f.run();
    await Promise.resolve();
    const cancelled = new Error("turn cancelled");
    const rejection = expect(pending).rejects.toBe(cancelled);
    controller.abort(cancelled);
    await rejection;
    authorization.resolve({ status: "allowed" });
    await Promise.resolve();
    expect(approvals.getApprovalAuditState(f.session.state).settlements).toHaveLength(0);
  });
});
