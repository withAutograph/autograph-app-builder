import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

import { sha256 } from "@/lib/agent/workflow-state";

const testModel = mockModel(({ lastUserMessage, toolResults }) => {
  const message = (lastUserMessage ?? "").toLowerCase();
  if (message.includes("report artifact workflow status")) {
    const result = [...toolResults]
      .reverse()
      .find(({ name }) => name === "artifact_workflow_status");
    if (result === undefined)
      return { toolCalls: [{ name: "artifact_workflow_status", input: {} }] };
    return result.isError
      ? "The artifact workflow status could not be verified."
      : `Artifact workflow status: ${JSON.stringify(result.output)}`;
  }
  if (
    message.includes("record a replacement prototype artifact") ||
    message.includes("retry recording the exact replacement prototype artifact")
  ) {
    const content = "replacement artifact";
    const digest = sha256(content);
    const results = toolResults.filter(
      ({ name }) => name === "record_prototype_artifact",
    );
    const latest = results.at(-1);
    const matching = results.filter(
      (result) =>
        !result.isError &&
        (result.output as { digest?: string } | undefined)?.digest === digest,
    );
    const requiredMatches = message.includes("retry recording") ? 2 : 1;
    if (latest?.isError)
      return "Prototype artifact recording was canceled; durable state was not changed.";
    if (matching.length >= requiredMatches) {
      const output = matching.at(-1)?.output as
        { invalidated?: boolean; reused?: boolean } | undefined;
      if (output?.reused === true)
        return "The retry reused the exact stored artifact revision without changing durable state.";
      return output?.invalidated === true
        ? "The new artifact revision invalidated the accepted AppSpec and proposal."
        : "The new artifact revision was recorded.";
    }
    return {
      toolCalls: [
        {
          name: "record_prototype_artifact",
          input: {
            path: "prototype/expense-review/app-spec.md",
            mediaType: "text/markdown",
            content,
          },
        },
      ],
    };
  }
  if (message.includes("read recorded prototype artifact")) {
    const stale = message.includes("stale digest");
    const recorded = [...toolResults]
      .reverse()
      .find(
        ({ name, isError }) => name === "record_prototype_artifact" && !isError,
      );
    if (recorded === undefined && !stale)
      return "Record a prototype artifact before reading it.";
    const artifact = recorded?.output as
      { path?: string; digest?: string } | undefined;
    const read = [...toolResults]
      .reverse()
      .find(({ name }) => name === "get_prototype_artifact");
    if (read !== undefined && !(stale && !read.isError)) {
      if (read.isError)
        return "The prototype artifact digest was rejected as stale.";
      const output = read.output as
        { path?: string; digest?: string; content?: string } | undefined;
      return output?.path === artifact?.path &&
        output?.digest === artifact?.digest &&
        typeof output?.content === "string"
        ? "The exact content-addressed prototype artifact was read without a target command."
        : "The prototype artifact readback did not match its recorded receipt.";
    }
    return {
      toolCalls: [
        {
          name: "get_prototype_artifact",
          input: {
            path: stale
              ? "prototype/expense-review/app-spec.md"
              : artifact?.path,
            digest: stale ? "0".repeat(64) : artifact?.digest,
          },
        },
      ],
    };
  }
  if (message.includes("assess workspace readiness before planning")) {
    const status = [...toolResults]
      .reverse()
      .find(({ name }) => name === "workspace_status");
    if (
      status === undefined ||
      (status.output as { phase?: string }).phase === "empty"
    )
      return { toolCalls: [{ name: "workspace_status", input: {} }] };
    const readiness = [...toolResults]
      .reverse()
      .find(({ name }) => name === "workspace_readiness_status");
    if (readiness === undefined)
      return { toolCalls: [{ name: "workspace_readiness_status", input: {} }] };
    return "The workspace readiness receipt is not ready for target execution, and no target command was run.";
  }
  if (message.includes("assess target command readiness")) {
    const statusResult = [...toolResults]
      .reverse()
      .find(({ name }) => name === "workspace_status");
    if (statusResult === undefined)
      return { toolCalls: [{ name: "workspace_status", input: {} }] };
    const status = statusResult.output as
      { phase?: string; proposal?: { digest?: string } } | undefined;
    if (status?.phase !== "planned")
      return { toolCalls: [{ name: "workspace_status", input: {} }] };
    const readinessResult = [...toolResults]
      .reverse()
      .find(({ name }) => name === "target_execution_status");
    const staleRequest = message.includes("stale proposal digest");
    if (
      readinessResult === undefined ||
      (staleRequest && !readinessResult.isError)
    ) {
      const digest = staleRequest ? "0".repeat(64) : status?.proposal?.digest;
      if (digest === undefined)
        return "A canonical proposal is required before target command readiness can be checked.";
      return {
        toolCalls: [
          {
            name: "target_execution_status",
            input: { expectedProposalDigest: digest },
          },
        ],
      };
    }
    if (readinessResult.isError)
      return "The target command readiness receipt rejected the stale proposal.";
    const readiness = readinessResult.output as
      { targetCommandReady?: boolean } | undefined;
    return readiness?.targetCommandReady === true
      ? "The exact proposal is ready for a future typed target command."
      : "The exact proposal is not ready for a target command, and no target command was run.";
  }
  if (message.includes("inspect the sandbox toolchain")) {
    const result = toolResults.find(
      ({ name }) => name === "inspect_sandbox_toolchain",
    );
    if (result === undefined)
      return {
        toolCalls: [{ name: "inspect_sandbox_toolchain", input: {} }],
      };
    return result.isError
      ? "Sandbox toolchain inspection failed."
      : `Sandbox toolchain receipt: ${JSON.stringify(result.output)}`;
  }
  const appSpecMatch =
    /^accept build-ready appspec for ([a-z0-9-]+):\n([\s\S]+)$/iu.exec(
      lastUserMessage ?? "",
    );
  if (appSpecMatch !== null) {
    const [, appId, appSpec] = appSpecMatch;
    if (appId === undefined || appSpec === undefined)
      return "The AppSpec request is malformed.";
    const statusResult = toolResults.find(
      ({ name }) => name === "workspace_status",
    );
    if (statusResult === undefined)
      return { toolCalls: [{ name: "workspace_status", input: {} }] };
    const status = statusResult.output as
      | {
          workspace?: {
            sourceSha?: string;
            eligibilityDigest?: string;
            workspaceDigest?: string;
          };
        }
      | undefined;
    const workspace = status?.workspace;
    const acceptanceResult = toolResults.find(
      ({ name }) => name === "accept_app_spec",
    );
    if (acceptanceResult === undefined) {
      const artifactResult = [...toolResults]
        .reverse()
        .find(({ name }) => name === "record_prototype_artifact");
      if (artifactResult === undefined)
        return {
          toolCalls: [
            {
              name: "record_prototype_artifact",
              input: {
                path: `prototype/${appId}/app-spec.md`,
                mediaType: "text/markdown",
                content: appSpec,
              },
            },
          ],
        };
      const artifact = artifactResult.output as
        { digest?: string; revision?: string } | undefined;
      if (
        workspace?.sourceSha === undefined ||
        workspace.eligibilityDigest === undefined ||
        workspace.workspaceDigest === undefined ||
        artifact?.digest === undefined ||
        artifact.revision === undefined
      )
        return "A verified prepared workspace is required before AppSpec acceptance.";
      return {
        toolCalls: [
          {
            name: "accept_app_spec",
            input: {
              appId,
              expectedArtifactDigest: artifact.digest,
              expectedArtifactRevision: artifact.revision,
              expectedSourceSha: workspace.sourceSha,
              expectedEligibilityDigest: workspace.eligibilityDigest,
              expectedWorkspaceDigest: workspace.workspaceDigest,
            },
          },
        ],
      };
    }
    if (acceptanceResult.isError)
      return "The AppSpec acceptance could not be recorded.";
    const accepted = acceptanceResult.output as { digest?: string } | undefined;
    const planResult = toolResults.find(
      ({ name }) => name === "plan_app_creation",
    );
    if (planResult === undefined) {
      if (accepted?.digest === undefined)
        return "The accepted AppSpec receipt is incomplete.";
      return {
        toolCalls: [
          {
            name: "plan_app_creation",
            input: { expectedAppSpecDigest: accepted.digest },
          },
        ],
      };
    }
    return planResult.isError
      ? "The canonical creation proposal could not be derived."
      : "The build-ready AppSpec was accepted and a digest-bound read-only creation proposal is ready. No target command has run.";
  }
  if (
    message.includes("prepare supported repository at ") ||
    message.includes("prepare fresh template at ")
  ) {
    const path = lastUserMessage?.match(
      /prepare (?:supported repository|fresh template) at (\/\S+)/iu,
    )?.[1];
    if (path === undefined) return "The configured test repository is missing.";
    const sourceKind = message.includes("prepare fresh template at ")
      ? "fresh-template"
      : "existing-repository";
    const inspectionResult = toolResults.find(
      ({ name }) => name === "inspect_source",
    );
    if (inspectionResult === undefined) {
      return {
        toolCalls: [{ name: "inspect_source", input: { path, sourceKind } }],
      };
    }
    const inspected = inspectionResult.output as
      | {
          digest?: string;
        }
      | undefined;
    if (inspectionResult.isError) {
      return "The configured repository could not be inspected.";
    }
    const acquisitionResult = toolResults.find(
      ({ name }) => name === "approve_source_acquisition",
    );
    if (sourceKind === "fresh-template" && acquisitionResult === undefined) {
      if (inspected?.digest === undefined)
        return "The configured source receipt is incomplete.";
      return {
        toolCalls: [
          {
            name: "approve_source_acquisition",
            input: { expectedSourceReceiptDigest: inspected.digest },
          },
        ],
      };
    }
    if (acquisitionResult?.isError) {
      const sourceStatus = toolResults.find(
        ({ name }) => name === "source_status",
      );
      if (sourceStatus === undefined)
        return { toolCalls: [{ name: "source_status", input: {} }] };
      return "Fresh-template acquisition was canceled or became stale; no workspace was materialized.";
    }
    const preparationResult = toolResults.find(
      ({ name }) => name === "prepare_workspace",
    );
    if (preparationResult === undefined) {
      if (inspected?.digest === undefined) {
        return "The configured repository is not eligible.";
      }
      return {
        toolCalls: [
          {
            name: "prepare_workspace",
            input: {
              expectedSourceReceiptDigest: inspected.digest,
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
    return "I can inspect an explicitly allowlisted existing repository or fresh-template local checkout and, after the required approvals, prepare its exact reviewed tree read-only inside an isolated Eve workspace. Fresh templates require a separate acquisition approval before independently approved materialization. Generated state remains release-disabled. I can record and exactly read session-bound prototype artifact receipts, accept a recorded AppSpec revision, derive a digest-bound read-only creation proposal, and report whether that exact proposal is blocked from target execution. Target mutation, change review, publication, cloning, and remote-template acquisition are not implemented yet.";
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
