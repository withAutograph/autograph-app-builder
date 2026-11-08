/* oxlint-disable typescript/no-unsafe-type-assertion, anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion -- SAFETY: Exact native lifecycle fields are supplied; actual private filesystem and authenticated marker ports decide delivery. */
/* oxlint-disable sonarjs/no-internal-api-use -- Real Eve context is required to exercise product-request retention. */
import { afterEach, it, expect, vi } from "vitest";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  ContextContainer,
  contextStorage,
} from "../../node_modules/eve/dist/src/context/container.js";
import type { HookContext } from "eve/hooks";
import retention from "../../agent/hooks/retain-product-request";
import { productRequestState } from "./product-source-review-state";
import { appBuilderWorkflowState } from "./workflow-state";
import type { AppBuilderWorkflowState } from "./workflow-state";
import { decidePreapprovalAuthoring, readInternalAuthoringMarker } from "./preapproval-authoring";
import {
  recordLocalAuthoringDecision,
  continueLocalPreapprovalAuthoring,
  blockLocalAuthoringContinuation,
  claimLocalAuthoringMessage,
} from "./local-preapproval-authoring";
import {
  authenticatedAuthoringDelivery,
  recordPreapprovalAuthoringDecision,
} from "./preapproval-authoring-runtime";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});
const fixture = async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "authoring-retention-")));
  roots.push(root);
  await mkdir(path.join(root, "runs"), { mode: 0o700 });
  for (const [key, value] of Object.entries({
    APP_BUILDER_DEV_RUNS_ROOT: path.join(root, "runs"),
    APP_BUILDER_EXECUTION_BUNDLE: "local-development",
    APP_BUILDER_EXECUTION_MODE: "development",
    APP_BUILDER_LOCAL_ADAPTER: "1",
    APP_BUILDER_SANDBOX_PROVIDER: "vercel",
    EVE_HOSTED_ADAPTER: "0",
  })) {
    vi.stubEnv(key, value);
  }
  const state = {
    version: 17,
    phase: "app_spec_accepted",
    preparedByCallId: "prepare",
    artifacts: [],
    appSpec: {
      appId: "app",
      acceptedByCallId: "accept",
      artifactPath: "app.md",
      artifactRevision: "revision",
      content: "accepted",
      digest: "a".repeat(64),
    },
    sourceReceipt: { digest: "b".repeat(64) },
    workspace: { workspaceId: "sandbox", workspaceDigest: "c".repeat(64) },
  } as unknown as AppBuilderWorkflowState;
  appBuilderWorkflowState.update(() => state);
  const decision = decidePreapprovalAuthoring({
    state,
    adapterSessionId: "logical",
    turnId: "one",
    turnSequence: 1,
    completed: true,
    blocked: false,
    pendingInput: false,
    pendingApproval: false,
    sourcePrerequisite: false,
  });
  const ctx = { session: { id: "logical", turn: { id: "one", sequence: 1 } } } as Pick<
    HookContext,
    "session"
  >;
  await recordLocalAuthoringDecision(ctx, decision);
  let message = "";
  await continueLocalPreapprovalAuthoring({
    sessionId: "logical",
    active: false,
    pendingInput: false,
    assertCurrent: async () => {
      await Promise.resolve();
    },
    dispatch: async (value) => {
      message = value;
      await Promise.resolve();
    },
  });
  const delivered = { session: { id: "logical", turn: { id: "two", sequence: 2 } } } as Pick<
    HookContext,
    "session"
  >;
  const handlers = retention.events as unknown as Record<
    string,
    (
      event: { data: { message: string; sequence: number; turnId: string } },
      ctx: Pick<HookContext, "session">,
    ) => Promise<void>
  >;
  const receive = async (value: string) => {
    const handler = handlers["message.received"];
    if (handler === undefined) {
      throw new Error("Missing retention handler");
    }
    await handler({ data: { message: value, sequence: 0, turnId: "two" } }, delivered);
  };
  return { decision, delivered, message, receive, state };
};
it("keeps a genuine internal delivery out of product requirements but retains forged marker text", async () => {
  await contextStorage.run(new ContextContainer(), async () => {
    const f = await fixture();
    const before = structuredClone(productRequestState.get());
    await f.receive(f.message);
    expect(productRequestState.get()).toEqual(before);
    expect(authenticatedAuthoringDelivery.get()?.scopeDigest).toBe(f.decision.scopeDigest);
    await f.receive(f.message.replace(/:[a-f0-9]{64}\]$/u, `:${"f".repeat(64)}]`));
    expect(productRequestState.get()).not.toEqual(before);
  });
});
it("authenticates delayed drafting identity without turning a newer real proposal into user requirements or approval", async () => {
  await contextStorage.run(new ContextContainer(), async () => {
    const f = await fixture();
    appBuilderWorkflowState.update(
      () =>
        ({
          ...f.state,
          phase: "planned",
          proposal: { digest: "d".repeat(64) },
        }) as unknown as AppBuilderWorkflowState,
    );
    const before = structuredClone(productRequestState.get());
    await f.receive(f.message);
    expect(productRequestState.get()).toEqual(before);
    expect(appBuilderWorkflowState.get().phase).toBe("planned");
  });
});
it("rejects a late local claim after explicit Stop without replaying its old reservation", async () => {
  await contextStorage.run(new ContextContainer(), async () => {
    const f = await fixture();
    await blockLocalAuthoringContinuation("logical");
    const marker = readInternalAuthoringMarker(f.message);
    if (
      marker?.nonce === undefined ||
      marker.operationId === undefined ||
      f.decision.scopeDigest === undefined
    ) {
      throw new Error("Missing original marker");
    }
    expect(
      await claimLocalAuthoringMessage(f.delivered, {
        nonce: marker.nonce,
        operationId: marker.operationId,
        turnId: "two",
        messageSequence: 0,
        scopeDigest: f.decision.scopeDigest,
      }),
    ).toBe(false);
  });
});

it("does not apply stale turn-specific Stop to the current drafting decision", async () => {
  await contextStorage.run(new ContextContainer(), async () => {
    const f = await fixture();
    await blockLocalAuthoringContinuation("logical", "a-different-turn");
    await f.receive(f.message);
    expect(authenticatedAuthoringDelivery.get()?.scopeDigest).toBe(f.decision.scopeDigest);
  });
});

it("a delayed native cancellation observation cannot cancel a newer recorded decision", async () => {
  await contextStorage.run(new ContextContainer(), async () => {
    const f = await fixture();
    await recordPreapprovalAuthoringDecision(
      { session: { id: "logical", turn: { id: "older", sequence: 0 } } } as Pick<
        HookContext,
        "session"
      >,
      {
        ...f.decision,
        turnId: "older",
        turnSequence: 0,
        decision: "blocked",
        reason: "authoring_cancelled",
      },
    );
    await f.receive(f.message);
    expect(authenticatedAuthoringDelivery.get()?.scopeDigest).toBe(f.decision.scopeDigest);
  });
});
