import { defineTool } from "eve/tools";
import { z } from "zod";

import { executeProductReadback } from "@/lib/agent/product-behavior";
import { recordProductBehaviorEvidence } from "@/lib/agent/product-behavior-state";
import { productAcceptanceObligations } from "@/lib/agent/product-acceptance";
import { appBuilderWorkflowState } from "@/lib/agent/workflow-state";
import { hasLiveWorkingPreview, workingPreviewState } from "@/lib/agent/working-preview-state";
import { assertHostedSandboxCommandAuthority } from "@/lib/sandbox/deployment-execution-lease";

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

export default defineTool({
  description:
    "Verify one narrow accepted outcome by sending an app-owned same-origin JSON POST to writePath with an unpredictable marker inserted at markerField, then GET readPath and compare the value at readPointer. This does not perform browser exercise, app authentication setup, restart durability, provider work, publication, or overall product completion.",
  async execute(input, ctx) {
    const current = appBuilderWorkflowState.get();
    if (!("applyReceipt" in current)) {
      throw new Error("An approved applied implementation is required before product readback.");
    }
    const { walkthrough } = productAcceptanceObligations(current.appSpec);
    if (!walkthrough.includes(input.acceptedOutcomeText)) {
      throw new Error("The requested outcome text is not present in the accepted walkthrough.");
    }
    const sandbox = await ctx.getSandbox();
    await assertHostedSandboxCommandAuthority({ sessionId: ctx.session.id });
    const preview = workingPreviewState.get();
    if (!hasLiveWorkingPreview(preview, sandbox.id) || preview === null) {
      throw new Error("A current working preview in this session's Sandbox is required.");
    }
    const result = await executeProductReadback({
      authority: {
        expiresAt: Date.parse(preview.receipt.expiresAt),
        launchUrl: preview.receipt.url,
      },
      scenario: input.scenario,
      signal: ctx.abortSignal,
    });
    recordProductBehaviorEvidence({
      acceptedOutcomeText: input.acceptedOutcomeText,
      appSpecDigest: current.appSpec.digest,
      applyDigest: current.applyReceipt.digest,
      observedAt: new Date().toISOString(),
      result,
    });
    return {
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
