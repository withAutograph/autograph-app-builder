/* oxlint-disable sonarjs/no-internal-api-use -- Exercise installed pinned SDK behavior through its real private compaction entrypoint. */
import { vi } from "vitest";
import { ToolLoopAgent, tool } from "ai";
import type { ModelMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import { compactMessages } from "../../node_modules/eve/dist/src/harness/compaction.js";

export const model = () =>
  new MockLanguageModelV4({
    // oxlint-disable-next-line typescript/promise-function-async -- Preserve the returned promise and synchronous throw behavior.
    doGenerate: () =>
      Promise.resolve({
        content: [{ type: "text", text: "Retained product instructions and completed history." }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 5, text: 5, reasoning: 0 },
        },
        warnings: [],
      }),
  });
export const call = {
  type: "tool-call" as const,
  toolCallId: "private-build-call",
  toolName: "apply_app_creation",
  input: { proposalDigest: "current-proposal" },
};
export const originalUser = {
  role: "user" as const,
  kind: "user",
  content: "Continue this same saved app with its reviewed Auth flow. ".repeat(15),
};
export const history = (approved = true): ModelMessage[] => [
  originalUser,
  { role: "assistant", content: "Older repository observations. ".repeat(4000) },
  {
    role: "assistant",
    content: [
      call,
      { type: "tool-approval-request", approvalId: "build-approval", toolCallId: call.toolCallId },
    ],
  },
  {
    role: "tool",
    content: [
      { type: "tool-approval-response", approvalId: "build-approval", approved },
      ...(approved
        ? []
        : [
            {
              type: "tool-result" as const,
              toolCallId: call.toolCallId,
              toolName: call.toolName,
              output: { type: "execution-denied" as const },
            },
          ]),
    ],
  },
];
// oxlint-disable-next-line typescript/promise-function-async -- Preserve the returned promise and synchronous throw behavior.
export const compact = (messages: ModelMessage[], recentWindowSize = 2) =>
  compactMessages(messages, model(), { recentWindowSize, threshold: 1800 });
export const execute = async (
  messages: ModelMessage[],
  abortSignal?: AbortSignal,
  apply: (
    input: { proposalDigest: string },
    options: { abortSignal?: AbortSignal },
    // oxlint-disable-next-line typescript/promise-function-async -- Preserve the returned promise and synchronous throw behavior.
  ) => Promise<{ state: string }> = vi.fn(() => Promise.resolve({ state: "applied" })),
) => {
  const agent = new ToolLoopAgent({
    model: model(),
    tools: {
      apply_app_creation: tool({
        inputSchema: z.strictObject({ proposalDigest: z.literal("current-proposal") }),
        execute: apply,
      }),
    },
  });
  await agent.generate({ messages, abortSignal });
  return apply;
};
