import { defineTool } from "eve/tools";
import { z } from "zod";

import {
  APP_BUILDER_SOURCE_VERSION,
  sourceWorkflowState,
} from "@/lib/agent/source-state";
import { inspectSourceReceipt } from "@/lib/repository/source-receipt";
import { cloneArrustedTemplate } from "@/lib/repository/arrusted-template";
import { hostedSourceReceipt } from "@/lib/repository/hosted-source";
import { hasTestCapability } from "@/lib/testing/test-capability";

export default defineTool({
  description:
    "Inspect an existing allowlisted checkout, or acquire the canonical Arrusted template for a new app and record its exact release-disabled receipt. Acquisition never uses a caller-provided remote or ref.",
  inputSchema: z
    .object({
      sourceKind: z.enum(["existing-repository", "fresh-template"]),
      path: z.string().min(1).optional(),
    })
    .superRefine((value, context) => {
      if (
        value.sourceKind === "existing-repository" &&
        value.path === undefined
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
  async execute({ sourceKind, path }) {
    const clone =
      sourceKind === "fresh-template" &&
      !(hasTestCapability("simulated-target") && path !== undefined)
        ? await cloneArrustedTemplate()
        : undefined;
    const receipt =
      clone?.receipt ??
      hostedSourceReceipt(sourceKind, path!) ??
      (await inspectSourceReceipt(sourceKind, path!));
    sourceWorkflowState.update(() => ({
      version: APP_BUILDER_SOURCE_VERSION,
      phase: "reviewed",
      receipt,
    }));
    return receipt;
  },
});
