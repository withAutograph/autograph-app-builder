import type { SandboxSession } from "eve/sandbox";
import { z } from "zod";

import type { AppBuilderWorkflowState } from "./workflow-state";

const appIdSchema = z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u);

/** Resolve a runnable app from the live checkout without granting build or publication approval. */
export const runnableSelectedApp = async (input: {
  appId?: string;
  sandbox: Pick<SandboxSession, "readTextFile">;
  state: AppBuilderWorkflowState;
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
      root: state.applyReceipt.applyRoot,
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
  const root = state.workspace.workspacePath;
  const appContract = await input.sandbox.readTextFile({
    path: `${root}/apps/${appId}/.config/app-spec.md`,
  });
  if (appContract === null || appContract === undefined) {
    throw new Error(
      `The selected checkout has no apps/${appId}/.config/app-spec.md. Choose an app that exists in this repository or repair its app contract before running preview tasks.`,
    );
  }
  return {
    appId,
    reusable: false,
    revision: `selected-existing:${state.githubSource.digest}`,
    root,
  };
};
