import { z } from "zod";

import type { AppBuilderWorkflowState } from "./workflow-state";

const appIdSchema = z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u);

/** Resolve a runnable app from the live checkout without granting build or publication approval. */
export const runnableSelectedApp = async (input: {
  appId?: string;
  state: AppBuilderWorkflowState;
  resolveRoot?: (selected: { appId: string; root: string }) => Promise<string>;
}): Promise<{ appId: string; root: string; revision: string; reusable: boolean }> => {
  const { state } = input;
  if ("applyReceipt" in state) {
    if (input.appId !== undefined && input.appId !== state.appSpec.appId) {
      throw new Error(
        `The requested app ${input.appId} does not match the accepted app ${state.appSpec.appId}.`,
      );
    }
    return {
      appId: state.appSpec.appId,
      reusable: true,
      revision: state.applyReceipt.digest,
      root:
        input.resolveRoot === undefined
          ? state.applyReceipt.applyRoot
          : await input.resolveRoot({
              appId: state.appSpec.appId,
              root: state.applyReceipt.applyRoot,
            }),
    };
  }
  if (
    state.phase === "empty" ||
    state.githubSource === undefined ||
    state.sourceReceipt.sourceKind !== "existing-repository"
  ) {
    throw new Error(
      "Select an existing GitHub app checkout, or apply an accepted new app build before running its preview or browser tasks.",
    );
  }
  if (input.appId === undefined) {
    throw new Error("Supply appId for the existing app in the selected GitHub checkout.");
  }
  const appId = appIdSchema.parse(input.appId);
  const root =
    input.resolveRoot === undefined
      ? state.workspace.workspacePath
      : await input.resolveRoot({ appId, root: state.workspace.workspacePath });
  return {
    appId,
    reusable: false,
    revision: `selected-existing:${state.githubSource.digest}`,
    root,
  };
};
