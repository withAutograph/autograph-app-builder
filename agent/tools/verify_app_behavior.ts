/* oxlint-disable github/filenames-match-regex, unicorn/filename-case -- Eve derives the public tool identifier from this existing filename. */
import { getBuilderSandboxId } from "../../lib/sandbox/builder-sandbox";
import { defineTool } from "eve/tools";
import { z } from "zod";

import { executeProductReadback } from "@/lib/agent/product-behavior";
import {
  recordProductBehaviorEvidence,
  captureProductBehaviorProvenance,
  currentProductBehaviorGeneration,
  hasCurrentProductBehaviorProvenance,
} from "@/lib/agent/product-behavior-state";
import { productAcceptanceObligations } from "@/lib/agent/product-acceptance";
import { appBuilderWorkflowState } from "@/lib/agent/workflow-state";
import { hasLiveWorkingPreview, workingPreviewState } from "@/lib/agent/working-preview-state";
import { assertHostedSandboxCommandAuthority } from "@/lib/sandbox/deployment-execution-lease";

interface ProductBehaviorDependencies {
  workflow: () =>
    | Exclude<ReturnType<typeof appBuilderWorkflowState.get>, { applyReceipt: object }>
    | {
        appSpec: Parameters<typeof productAcceptanceObligations>[0];
        applyReceipt: { digest: string };
      };
  generation: typeof currentProductBehaviorGeneration;
  authority: typeof assertHostedSandboxCommandAuthority;
  preview: typeof workingPreviewState.get;
  hasLive: typeof hasLiveWorkingPreview;
  capture: typeof captureProductBehaviorProvenance;
  readback: typeof executeProductReadback;
  record: typeof recordProductBehaviorEvidence;
  isCurrent: typeof hasCurrentProductBehaviorProvenance;
}

const productBehaviorDependencies: ProductBehaviorDependencies = {
  authority: assertHostedSandboxCommandAuthority,
  capture: captureProductBehaviorProvenance,
  generation: currentProductBehaviorGeneration,
  hasLive: hasLiveWorkingPreview,
  isCurrent: hasCurrentProductBehaviorProvenance,
  preview: () => workingPreviewState.get(),
  readback: executeProductReadback,
  record: recordProductBehaviorEvidence,
  workflow: () => appBuilderWorkflowState.get(),
};

const relativeHttpPath = z.string().startsWith("/").max(2048);
const scenarioSchema = z.strictObject({
  body: z.record(z.string(), z.unknown()).describe("JSON body for the app-owned POST."),
  markerField: z
    .string()
    .min(1)
    .max(128)
    .describe("Top-level POST body field that receives the verifier marker."),
  outcomeId: z.string().min(1).max(200),
  readPath: relativeHttpPath.describe("Same-origin app path for the independent GET."),
  readPointer: z
    .string()
    .startsWith("/")
    .max(1024)
    .describe("JSON Pointer where the GET must return the marker."),
  writePath: relativeHttpPath.describe("Same-origin app path for the JSON POST."),
});

export const createVerifyAppBehaviorTool = (dependencies: ProductBehaviorDependencies) =>
  defineTool({
    description:
      "Verify one narrow accepted outcome by sending an app-owned same-origin JSON POST to writePath with an unpredictable marker inserted at markerField, then GET readPath and compare the value at readPointer. This does not perform browser exercise, app authentication setup, restart durability, provider work, publication, or overall product completion.",
    async execute(input, ctx) {
      const current = dependencies.workflow();
      if (!("applyReceipt" in current)) {
        throw new Error("An approved applied implementation is required before product readback.");
      }
      const { walkthrough } = productAcceptanceObligations(current.appSpec);
      if (!walkthrough.includes(input.acceptedOutcomeText)) {
        throw new Error("The requested outcome text is not present in the accepted walkthrough.");
      }
      const sourceGeneration = dependencies.generation();
      const sandbox = await ctx.getSandbox();
      await dependencies.authority({ sessionId: ctx.session.id });
      const preview = dependencies.preview();
      if (!dependencies.hasLive(preview, getBuilderSandboxId(sandbox)) || preview === null) {
        throw new Error("A current working preview in this session's Sandbox is required.");
      }
      const provenance = dependencies.capture(preview.commandId);
      if (provenance === undefined || provenance.sourceGeneration !== sourceGeneration) {
        throw new Error(
          "Reopen the working preview after implementation changes before verifying behavior.",
        );
      }
      const result = await dependencies.readback({
        authority: {
          expiresAt: Date.parse(preview.receipt.expiresAt),
          launchUrl: preview.receipt.url,
        },
        scenario: input.scenario,
        signal: ctx.abortSignal,
      });
      dependencies.record({
        acceptedOutcomeText: input.acceptedOutcomeText,
        appSpecDigest: current.appSpec.digest,
        applyDigest: current.applyReceipt.digest,
        observedAt: new Date().toISOString(),
        provenance,
        result,
      });
      return {
        eligibility: dependencies.isCurrent(provenance)
          ? ("current" as const)
          : ("historical-only" as const),
        evidence: result,
        productStatus: "unassessed" as const,
        reason:
          "One action/readback check is partial evidence and cannot establish overall product completion.",
      };
    },
    inputSchema: z.strictObject({
      acceptedOutcomeText: z.string().trim().min(10).max(4000),
      scenario: scenarioSchema,
    }),
  });

export default createVerifyAppBehaviorTool(productBehaviorDependencies);
