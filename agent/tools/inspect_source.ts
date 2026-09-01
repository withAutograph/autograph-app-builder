import { defineTool } from "eve/tools";
import { z } from "zod";

import {
  APP_BUILDER_SOURCE_VERSION,
  sourceWorkflowState,
} from "@/lib/agent/source-state";
import { inspectSourceReceipt } from "@/lib/repository/source-receipt";
import { acquireCanonicalArrustedTemplate } from "@/lib/repository/arrusted-template";
import {
  canAutoSelectDevelopmentSource,
  developmentSourceReceipt,
} from "@/lib/repository/development-source";
import { hasTestCapability } from "@/lib/testing/test-capability";

export default defineTool({
  description:
    "Inspect the exact preselected Development snapshot or an explicit allowlisted existing checkout, or clone the canonical Arrusted template once into this app build's workspace and record its exact release-disabled receipt. Acquisition never uses a caller-provided remote or ref.",
  inputSchema: z
    .object({
      sourceKind: z.enum(["existing-repository", "fresh-template"]),
      path: z.string().min(1).optional(),
    })
    .superRefine((value, context) => {
      if (
        value.sourceKind === "existing-repository" &&
        value.path === undefined &&
        !canAutoSelectDevelopmentSource()
      )
        context.addIssue({
          code: "custom",
          path: ["path"],
          message: "Existing repositories require an allowlisted local path.",
        });
      if (
        value.sourceKind === "fresh-template" &&
        value.path !== undefined &&
        !hasTestCapability("simulated-target")
      )
        context.addIssue({
          code: "custom",
          path: ["path"],
          message:
            "Fresh templates are acquired from the canonical Arrusted remote.",
        });
    }),
  async execute({ sourceKind, path }, ctx) {
    let receipt = await developmentSourceReceipt(sourceKind, path);
    if (
      receipt === undefined &&
      sourceKind === "fresh-template" &&
      !(hasTestCapability("simulated-target") && path !== undefined)
    )
      receipt = await acquireCanonicalArrustedTemplate({
        sandbox: await ctx.getSandbox(),
        callId: ctx.callId,
      });
    if (receipt === undefined) {
      if (path === undefined)
        throw new Error(
          "Existing repositories require an allowlisted local path.",
        );
      receipt = await inspectSourceReceipt(sourceKind, path);
    }
    sourceWorkflowState.update(() => ({
      version: APP_BUILDER_SOURCE_VERSION,
      phase: "reviewed",
      receipt,
    }));
    return receipt;
  },
});
