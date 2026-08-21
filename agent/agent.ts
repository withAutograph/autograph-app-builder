import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

const testModel = mockModel(({ lastUserMessage }) => {
  const message = (lastUserMessage ?? "").toLowerCase();
  if (message.includes("capabilities")) {
    return "I can design an app, prepare an isolated supported repository workspace, plan a Next.js app, create a reviewed change set, and publish only after a separate approval.";
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
