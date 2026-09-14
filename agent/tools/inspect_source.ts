import { defineTool } from "eve/tools";
import { z } from "zod";

import { APP_BUILDER_SOURCE_VERSION, sourceWorkflowState } from "@/lib/agent/source-state";
import { acquireCanonicalArrustedTemplate } from "@/lib/repository/arrusted-template";
import {
  canAutoSelectDevelopmentSource,
  developmentSourceReceipt,
} from "@/lib/repository/development-source";
import { hasTestCapability } from "@/lib/testing/test-capability";
import { isHostedVercelRuntime } from "@/lib/sandbox/backend";
import { inspectSourceReceipt } from "@/lib/repository/source-receipt";

export default defineTool({
  description:
    "Inspect the exact preselected Development snapshot or an explicit allowlisted existing checkout, or clone the canonical Arrusted template once into this app build's workspace and record its exact release-disabled receipt. Acquisition never uses a caller-provided remote or ref.",
  async execute({ sourceKind, path }, ctx) {
    let receipt = await developmentSourceReceipt(sourceKind, path);
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
      const selected = sourceWorkflowState.get();
      if (selected.phase !== "empty") {
        ({ receipt } = selected);
      }
    }
    if (receipt === undefined && path !== undefined && !isHostedVercelRuntime(process.env)) {
      receipt = await inspectSourceReceipt(sourceKind, path);
    }
    if (receipt === undefined) {
      throw new Error("The selected source is not available in this app build session.");
    }
    sourceWorkflowState.update(() => ({
      phase: "reviewed",
      receipt,
      version: APP_BUILDER_SOURCE_VERSION,
    }));
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
