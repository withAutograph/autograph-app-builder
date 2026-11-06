import type { ToolContext } from "eve/tools";
import { LocalPlanningSourcePrerequisiteError } from "../repository/local-planning-source-prerequisite";
import { currentLocalSourcePrerequisite } from "./local-source-prerequisite-state";
import { appBuilderWorkflowState } from "./workflow-state";
import { emitCurrentBuildWorkflowProjection } from "./approved-build-continuation-runtime";

/** A normal tool result commits the observed prerequisite instead of reviving an older validator failure. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Catch boundary immediately checks the typed source error and rethrows every other value.
export const localSourcePrerequisiteResponse = async (error: unknown, ctx: ToolContext) => {
  if (!(error instanceof LocalPlanningSourcePrerequisiteError)) {
    throw error;
  }
  const observation = currentLocalSourcePrerequisite(appBuilderWorkflowState.get(), ctx.session.id);
  if (observation === undefined) {
    throw error;
  }
  await emitCurrentBuildWorkflowProjection(ctx);
  return {
    code: error.code,
    nextAction:
      "Recover the original immutable local source artifact for this saved app, then prepare a fresh source plan through Builder. Existing app bytes, approvals and data remain retained.",
    problem: error.message,
    sourcePrerequisite: observation,
    status: "blocked" as const,
  };
};
