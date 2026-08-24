import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

const testModel = mockModel(({ lastUserMessage, toolResults }) => {
  const message = (lastUserMessage ?? "").toLowerCase();
  if (message.includes("prepare supported repository at ")) {
    const path = lastUserMessage?.match(
      /prepare supported repository at (\/\S+)/iu,
    )?.[1];
    if (path === undefined) return "The configured test repository is missing.";
    if (toolResults.length === 0) {
      return { toolCalls: [{ name: "inspect_repository", input: { path } }] };
    }
    const inspected = toolResults[0]?.output as
      | {
          eligible?: boolean;
          sourceSha?: string;
          digest?: string;
        }
      | undefined;
    if (toolResults.length === 1) {
      if (
        inspected?.eligible !== true ||
        inspected.sourceSha === undefined ||
        inspected.digest === undefined
      ) {
        return "The configured repository is not eligible.";
      }
      return {
        toolCalls: [
          {
            name: "prepare_workspace",
            input: {
              path,
              expectedSha: inspected.sourceSha,
              expectedEligibilityDigest: inspected.digest,
            },
          },
        ],
      };
    }
    return "The reviewed repository was prepared inside the Eve session workspace.";
  }
  if (message.includes("capabilities")) {
    return "I can inspect an existing supported local checkout and, after approval, prepare its exact reviewed tree read-only inside an isolated Eve workspace. Planning, prototype delivery, mutation, change review, publication, and fresh-template acquisition are not implemented yet.";
  }
  return "I am the Autograph App Builder. Tell me whether you are starting from the supported template or iterating on an existing supported repository, and describe the app outcome you want.";
});

export default defineAgent({
  model:
    process.env.APP_BUILDER_TEST_MODEL === "1"
      ? testModel
      : "openai/gpt-5.6-terra",
  modelContextWindowTokens: 128_000,
  reasoning: "high",
  limits: {
    maxInputTokensPerSession: 2_000_000,
    maxOutputTokensPerSession: 200_000,
    sessionTimeoutMs: 7 * 24 * 60 * 60 * 1_000,
  },
});
