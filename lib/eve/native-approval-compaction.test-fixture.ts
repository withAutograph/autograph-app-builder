/* oxlint-disable sonarjs/no-internal-api-use -- Exercise installed pinned SDK behavior through its real private compaction entrypoint. */
import { vi } from "vitest";
import { ToolLoopAgent, tool } from "ai";
import type { ModelMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import { compactMessages } from "../../node_modules/eve/dist/src/harness/compaction.js";

export const model = () =>
  new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ text: "Retained product instructions and completed history.", type: "text" }],
      finishReason: { raw: "stop", unified: "stop" },
      usage: {
        inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 10, total: 10 },
        outputTokens: { reasoning: 0, text: 5, total: 5 },
      },
      warnings: [],
    }),
  });
export const call = {
  input: { proposalDigest: "current-proposal" },
  toolCallId: "private-build-call",
  toolName: "apply_app_creation",
  type: "tool-call" as const,
};
export const originalUser = {
  content: "Continue this same saved app with its reviewed Auth flow. ".repeat(15),
  kind: "user",
  role: "user" as const,
};
export const history = (approved = true): ModelMessage[] => [
  originalUser,
  { content: "Older repository observations. ".repeat(4000), role: "assistant" },
  {
    content: [
      call,
      { approvalId: "build-approval", toolCallId: call.toolCallId, type: "tool-approval-request" },
    ],
    role: "assistant",
  },
  {
    content: [
      { approvalId: "build-approval", approved, type: "tool-approval-response" },
      ...(approved
        ? []
        : [
            {
              output: { type: "execution-denied" as const },
              toolCallId: call.toolCallId,
              toolName: call.toolName,
              type: "tool-result" as const,
            },
          ]),
    ],
    role: "tool",
  },
];
export const compact = async (messages: ModelMessage[], recentWindowSize = 2) =>
  await compactMessages(messages, model(), { recentWindowSize, threshold: 1800 });
export const execute = async (
  messages: ModelMessage[],
  abortSignal?: AbortSignal,
  apply: (
    input: { proposalDigest: string },
    options: { abortSignal?: AbortSignal },
  ) => Promise<{ state: string }> = vi.fn(async () => ({ state: "applied" })),
) => {
  const agent = new ToolLoopAgent({
    model: model(),
    tools: {
      apply_app_creation: tool({
        execute: apply,
        inputSchema: z.strictObject({ proposalDigest: z.literal("current-proposal") }),
      }),
    },
  });
  await agent.generate({ abortSignal, messages });
  return apply;
};
