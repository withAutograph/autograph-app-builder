import { withBuilderGatewayReporting } from "./builder-gateway-reporting";
import { createHash } from "node:crypto";

import { defineDynamic } from "eve";
import type { AgentStaticModelDefinition } from "eve";

import { activeBuilderModelId, builderValidationModelId } from "@/lib/integrations/active-model";
import { appBuilderWorkflowState } from "./workflow-state";
import type { AppBuilderWorkflowState } from "./workflow-state";

const discoveryPhases = new Set<AppBuilderWorkflowState["phase"]>([
  "empty",
  "prepared",
  "ui_previewed",
  "ui_accepted",
]);

/** Product discovery stays on Luna; accepted functional work uses Sol. */
export const builderModelForPhase = (phase: AppBuilderWorkflowState["phase"]) =>
  discoveryPhases.has(phase) ? activeBuilderModelId : builderValidationModelId;

export const builderModelConfiguration = ({
  localDevelopment,
  testModel,
}: {
  localDevelopment: boolean;
  testModel?: AgentStaticModelDefinition;
}) => {
  const reasoning: "low" | "high" = localDevelopment ? "low" : "high";
  if (testModel !== undefined) {
    return { model: testModel, modelContextWindowTokens: 128_000, reasoning };
  }
  return {
    model: defineDynamic({
      events: {
        // Read the saved state at each native model step, including resumed turns.
        "step.started": (_event, ctx) => {
          const { phase } = appBuilderWorkflowState.get();
          const modelId = builderModelForPhase(phase);
          // Selection evidence only: this does not assert a provider call succeeded.
          try {
            console.info("[builder:model-selection]", {
              event: "builder.model_selection",
              modelId,
              phase,
              sessionIdHash: `sha256:${createHash("sha256").update(ctx.session.id).digest("hex")}`,
            });
          } catch {
            // Diagnostics have no authority over native model selection.
          }
          return {
            model: modelId,
            modelContextWindowTokens: 128_000,
            modelOptions: {
              providerOptions: withBuilderGatewayReporting(
                { gateway: { only: ["openai"], order: ["openai"] } },
                () => ctx.session.id,
                "main",
              ),
            },
            reasoning,
          };
        },
      },
    }),
  };
};
