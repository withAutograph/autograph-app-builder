import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

import {
  appBuilderWorkflowState,
  sha256,
  validAppId,
  workflowWorkspace,
} from "@/lib/agent/workflow-state";

function validBuildReadyAppSpec(content: string): boolean {
  const headings = [
    "Status and prototype",
    "User and outcome",
    "Interfaces and navigation",
    "Controls and behavior",
    "Data model",
    "Integrations and reconciliation",
    "Temporal semantics",
    "Writes, review, and authority",
    "Access and tenancy",
    "Agent behavior",
    "Operational states",
    "Defaults, non-goals, and risks",
    "Acceptance walkthrough",
    "Build handoff",
  ];
  if (
    headings.some(
      (heading) =>
        (content.match(new RegExp(`^## ${heading}$`, "gmu")) ?? []).length !==
        1,
    )
  )
    return false;
  const block = /^## Build handoff\n\n```json\n([\s\S]*?)\n```$/mu.exec(
    content,
  );
  if (block?.[1] === undefined) return false;
  try {
    const handoff = JSON.parse(block[1]) as unknown;
    return (
      typeof handoff === "object" &&
      handoff !== null &&
      !Array.isArray(handoff) &&
      (handoff as { status?: unknown }).status === "build-ready"
    );
  } catch {
    return false;
  }
}

export default defineTool({
  description:
    "Record explicit acceptance of one complete build-ready AppSpec. The acceptance is bound to the prepared workspace receipt and does not write or execute anything in the target repository.",
  inputSchema: z.object({
    appId: z.string().min(1),
    appSpec: z.string().min(1),
    expectedSourceSha: z.string().regex(/^[0-9a-f]{40}$/u),
    expectedEligibilityDigest: z.string().regex(/^[0-9a-f]{64}$/u),
    expectedWorkspaceDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  }),
  approval: always(),
  async execute(
    {
      appId,
      appSpec,
      expectedSourceSha,
      expectedEligibilityDigest,
      expectedWorkspaceDigest,
    },
    ctx,
  ) {
    if (!validAppId(appId))
      throw new Error("App id must be one lowercase kebab-case segment.");
    if (!validBuildReadyAppSpec(appSpec))
      throw new Error("AppSpec is not a complete build-ready AppSpec.");
    const current = appBuilderWorkflowState.get();
    const workspace = workflowWorkspace(current);
    if (workspace === undefined)
      throw new Error(
        "Prepare an eligible repository before accepting an AppSpec.",
      );
    if (
      workspace.sourceSha !== expectedSourceSha ||
      workspace.eligibilityDigest !== expectedEligibilityDigest ||
      workspace.workspaceDigest !== expectedWorkspaceDigest
    )
      throw new Error(
        "The prepared workspace receipt changed before AppSpec acceptance.",
      );
    const accepted = {
      appId,
      content: appSpec,
      digest: sha256(appSpec),
      acceptedByCallId: ctx.callId,
    };
    if (
      (current.phase === "app_spec_accepted" || current.phase === "planned") &&
      current.appSpec.digest === accepted.digest &&
      current.appSpec.appId === accepted.appId
    )
      return { ...current.appSpec, reused: true };
    appBuilderWorkflowState.update(() => ({
      version: 1,
      phase: "app_spec_accepted",
      workspace,
      appSpec: accepted,
    }));
    return { ...accepted, reused: false };
  },
});
