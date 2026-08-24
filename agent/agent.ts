import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

const testModel = mockModel(({ lastUserMessage, toolResults }) => {
  const message = (lastUserMessage ?? "").toLowerCase();
  if (message.includes("prepare supported repository at ")) {
    const path = lastUserMessage?.match(
      /prepare supported repository at (\/\S+)/iu,
    )?.[1];
    if (path === undefined) return "The configured test repository is missing.";
    const inspectionResult = toolResults.find(
      ({ name }) => name === "inspect_repository",
    );
    if (inspectionResult === undefined) {
      return { toolCalls: [{ name: "inspect_repository", input: { path } }] };
    }
    const inspected = inspectionResult.output as
      | {
          eligible?: boolean;
          sourceSha?: string;
          digest?: string;
        }
      | undefined;
    if (inspectionResult.isError) {
      return "The configured repository could not be inspected.";
    }
    const preparationResult = toolResults.find(
      ({ name }) => name === "prepare_workspace",
    );
    if (preparationResult === undefined) {
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
    const statusResult = toolResults.find(
      ({ name }) => name === "workspace_status",
    );
    if (statusResult === undefined) {
      return { toolCalls: [{ name: "workspace_status", input: {} }] };
    }
    if (statusResult.isError) {
      return "The workspace status could not be verified.";
    }
    const status = statusResult.output as { phase?: string } | undefined;
    if (preparationResult.isError) {
      return status?.phase === "empty"
        ? "Preparation was canceled, and the workspace phase remains empty."
        : "Preparation was canceled, but the workspace phase could not be confirmed empty.";
    }
    return status?.phase === "prepared"
      ? "The reviewed repository was prepared inside the Eve session workspace, and workspace status confirms the prepared phase."
      : "The repository preparation completed, but workspace status did not confirm the prepared phase.";
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
