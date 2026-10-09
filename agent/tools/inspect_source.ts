import { defineTool } from "eve/tools";
import { z } from "zod";

import { APP_BUILDER_SOURCE_VERSION, sourceWorkflowState } from "@/lib/agent/source-state";
import type { SourceWorkflowState } from "@/lib/agent/source-state";
import type { SourceReceipt } from "@/lib/repository/source-receipt";
import { appBuilderWorkflowState } from "@/lib/agent/workflow-state";
import type { AppBuilderWorkflowState } from "@/lib/agent/workflow-state";
import { selectedGitHubSourceForSandboxRestore } from "@/lib/agent/restore-selected-github-sandbox-source";
import { acquireCanonicalArrustedTemplate } from "@/lib/repository/arrusted-template";
import {
  canAutoSelectDevelopmentSource,
  developmentSourceReceipt,
} from "@/lib/repository/development-source";
import { hasTestCapability } from "@/lib/testing/test-capability";
import { isHostedVercelRuntime } from "@/lib/sandbox/backend";
import { inspectSourceReceipt } from "@/lib/repository/source-receipt";

const retainedSourceReceipt = (
  source: SourceWorkflowState,
  workflow: AppBuilderWorkflowState,
): SourceReceipt | undefined => {
  if (source.phase !== "empty") {
    return source.receipt;
  }
  if (workflow.phase !== "empty") {
    return workflow.sourceReceipt;
  }
  return undefined;
};

export default defineTool({
  description:
    "Inspect the exact preselected Development snapshot or an explicit allowlisted existing checkout, or clone the canonical Arrusted template once into this app build's workspace and record its exact release-disabled receipt. Acquisition never uses a caller-provided remote or ref.",
  async execute({ sourceKind, path }, ctx) {
    const selected = sourceWorkflowState.get();
    const workflow = appBuilderWorkflowState.get();
    const githubSource = selectedGitHubSourceForSandboxRestore({
      sourceState: selected.phase === "empty" ? undefined : selected.githubSource,
      workflowState: workflow.phase === "empty" ? undefined : workflow.githubSource,
    });
    // Hosted source inspection retains the selected app checkout; normal source
    // edits and a moving branch head do not authorize replacing its binding.
    let receipt =
      githubSource !== undefined && isHostedVercelRuntime(process.env)
        ? retainedSourceReceipt(selected, workflow)
        : await developmentSourceReceipt(sourceKind, path);
    if (
      receipt === undefined &&
      sourceKind === "fresh-template" &&
      !(hasTestCapability("simulated-target") && path !== undefined)
    ) {
      receipt = await acquireCanonicalArrustedTemplate({
        callId: ctx.callId,
        sandbox: () => ctx.getSandbox(),
        sessionId: ctx.session.id,
      });
    }
    if (receipt === undefined && isHostedVercelRuntime(process.env)) {
      const current = sourceWorkflowState.get();
      if (current.phase !== "empty") {
        ({ receipt } = current);
      }
    }
    if (receipt === undefined && path !== undefined && !isHostedVercelRuntime(process.env)) {
      receipt = await inspectSourceReceipt(sourceKind, path);
    }
    if (receipt === undefined) {
      throw new Error("The selected source is not available in this app build session.");
    }
    sourceWorkflowState.update(() => {
      const next: SourceWorkflowState = {
        phase: "reviewed",
        receipt,
        version: APP_BUILDER_SOURCE_VERSION,
      };
      if (githubSource !== undefined) {
        next.githubSource = githubSource;
      }
      return next;
    });
    return receipt;
  },
  inputSchema: z
    .object({
      path: z.string().min(1).optional(),
      sourceKind: z.enum(["existing-repository", "fresh-template"]),
    })
    .superRefine((value, context) => {
      if (
        value.sourceKind === "existing-repository" &&
        value.path === undefined &&
        !canAutoSelectDevelopmentSource()
      ) {
        context.addIssue({
          code: "custom",
          message: "Existing repositories require an allowlisted local path.",
          path: ["path"],
        });
      }
      if (
        value.sourceKind === "fresh-template" &&
        value.path !== undefined &&
        !hasTestCapability("simulated-target")
      ) {
        context.addIssue({
          code: "custom",
          message: "Fresh templates are acquired from the canonical Arrusted remote.",
          path: ["path"],
        });
      }
    }),
});
