/* oxlint-disable sonarjs/no-internal-api-use -- Exercise the real pinned SDK compaction and approved-execution boundary. */
import { describe, expect, it, vi } from "vitest";
import { compactMessages } from "../../node_modules/eve/dist/src/harness/compaction.js";
import { authorizeRepeatablePrivateApplyCalls } from "./native-recovery-repeatable-apply";
import {
  model,
  call,
  originalUser,
  history,
  compact,
  execute,
} from "./native-approval-compaction.test-fixture";

describe("real native compaction before the SDK approved-tool execution", () => {
  it("retains the original user before the pending approval and executes the actual approved call once", async () => {
    const source = history();
    const compacted = await compact(source);
    expect(compacted.length).toBeLessThan(source.length + 2);
    const apply = await execute(compacted);
    expect(apply).toHaveBeenCalledExactlyOnceWith(
      { proposalDigest: "current-proposal" },
      expect.anything(),
    );
    expect(
      compacted.some(
        (message) => message.role === "user" && message.content === originalUser.content,
      ),
    ).toBe(true);
  });
  it("retains the original pending call eligibility across the owned failed-planned handoff", async () => {
    const compacted = await compact(history());
    const binding = { logicalSessionId: "saved-session", ownerRunId: "current-owned-run" };
    const scope = {
      appId: "app",
      appSpecDigest: "spec",
      proposalDigest: "current-proposal",
      sessionId: binding.logicalSessionId,
      workspaceId: "private-workspace",
    };
    const context = {
      "autograph-app-builder.private-apply-authority.v1": {
        grant: { ...scope, proposalDigest: "older-approved-proposal" },
        pending: [{ callId: call.toolCallId, scope }],
      },
      "autograph-app-builder.workflow.v17": {
        appSpec: { digest: "spec" },
        phase: "planned",
        proposal: { digest: "current-proposal", target: { contract: { appId: "app" } } },
        workspace: { workspaceDigest: "current-workspace-digest", workspaceId: scope.workspaceId },
      },
      "eve.sessionId": binding.logicalSessionId,
    };
    const input = {
      binding,
      descriptor: { logicalSessionId: binding.logicalSessionId },
      payload: {
        binding,
        candidates: [
          {
            origin: { slot: 13 },
            serializedContext: context,
            sessionState: {
              snapshot: { session: { history: compacted, sessionId: binding.logicalSessionId } },
            },
          },
        ],
      },
    };
    const before = structuredClone(input);
    expect(authorizeRepeatablePrivateApplyCalls(input)).toEqual([call.toolCallId]);
    expect(input).toEqual(before);
    expect(await execute(compacted)).toHaveBeenCalledOnce();
  });
  it("preserves cancellation at the approved tool's actual effect guard", async () => {
    const compacted = await compact(history());
    const abort = new AbortController();
    abort.abort(new Error("Cancelled before approval resumption"));
    const effect = vi.fn();
    const apply = vi.fn(
      async (_input: { proposalDigest: string }, options: { abortSignal?: AbortSignal }) => {
        options.abortSignal?.throwIfAborted();
        effect();
        return { state: "applied" };
      },
    );
    await execute(compacted, abort.signal, apply);
    expect(apply).toHaveBeenCalledOnce();
    expect(apply.mock.calls[0]?.[1].abortSignal).toBe(abort.signal);
    expect(effect).not.toHaveBeenCalled();
  });
  it("preserves the actual heuristic path without a prior compaction checkpoint", async () => {
    const summarize = model();
    const messages = [
      originalUser,
      {
        content: [
          {
            input: {},
            toolCallId: "observed",
            toolName: "inspect_repository",
            type: "tool-call" as const,
          },
        ],
        role: "assistant" as const,
      },
      {
        content: [
          {
            output: {
              type: "text" as const,
              value: "Large controlled observation. ".repeat(30_000),
            },
            toolCallId: "observed",
            toolName: "inspect_repository",
            type: "tool-result" as const,
          },
        ],
        role: "tool" as const,
      },
      ...history().slice(-2),
    ];
    const compacted = await compactMessages(messages, summarize, {
      recentWindowSize: 2,
      threshold: 20_000,
    });
    expect(summarize.doGenerateCalls).toHaveLength(0);
    expect(compacted[0]).toEqual(originalUser);
    expect(await execute(compacted)).toHaveBeenCalledOnce();
  });
  it("preserves denial and never executes a rejected call", async () => {
    const compacted = await compact(history(false));
    expect(await execute(compacted)).not.toHaveBeenCalled();
  });
  it("preserves genuinely new user instructions instead of moving them across an approval", async () => {
    const latest = {
      content: "Cancel this change; first explain the saved app status.",
      kind: "user",
      role: "user" as const,
    };
    const compacted = await compact([...history(), latest], 3);
    expect(compacted.at(-1)).toEqual(latest);
    expect(await execute(compacted)).not.toHaveBeenCalled();
  });
});
