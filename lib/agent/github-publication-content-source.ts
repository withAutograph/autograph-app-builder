import type { SandboxSession } from "eve/sandbox";

import type { AppBuilderWorkflowState } from "./workflow-state";
import type { GitHubPublicationContentSource } from "../repository/github-publication";
import {
  inspectApplyOverlay,
  inspectFixtureApplyOverlay,
} from "../repository/target-apply";
import { hasTestCapability } from "../testing/test-capability";

type ReviewedWorkflow = Extract<AppBuilderWorkflowState, { phase: "reviewed" }>;

/**
 * Re-observes the validated apply overlay once, then exposes only exact file
 * postimages to the publication runtime. No bytes are retained in workflow or
 * durable publication state.
 */
export async function publicationContentSourceForReviewedWorkflow(input: {
  state: ReviewedWorkflow;
  sandbox: SandboxSession;
}): Promise<GitHubPublicationContentSource> {
  const observed = hasTestCapability("simulated-target")
    ? await inspectFixtureApplyOverlay(
        input.sandbox,
        input.state.applyReceipt.applyRoot,
        input.state.appSpec.appId,
      )
    : await inspectApplyOverlay(
        input.sandbox,
        input.state.applyReceipt.applyRoot,
      );
  if (observed.treeDigest !== input.state.applyReceipt.postTreeDigest)
    throw new Error(
      "The validated apply overlay changed before GitHub publication.",
    );
  const files = new Map(observed.files.map((file) => [file.path, file]));
  const relativeRoot = input.state.applyReceipt.applyRoot.replace(
    /^\/workspace\//u,
    "",
  );
  return {
    async readFile(path) {
      const file = files.get(path);
      if (file === undefined) return null;
      const bytes = await input.sandbox.readBinaryFile({
        path: `${relativeRoot}/${path}`,
      });
      if (bytes === null) return null;
      return { mode: file.mode, digest: file.digest, bytes };
    },
  };
}
