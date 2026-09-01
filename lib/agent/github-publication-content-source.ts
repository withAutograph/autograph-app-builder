import type { SandboxSession } from "eve/sandbox";
import { createHash } from "node:crypto";

import type { AppBuilderWorkflowState } from "./workflow-state";
import type { GitHubPublicationContentSource } from "../repository/github-publication";
import { inspectSourceBoundSandboxWorkspace } from "../repository/arrusted-template";
import {
  inspectApplyOverlay,
  inspectFixtureApplyOverlay,
} from "../repository/target-apply";
import { readPreparedSandboxSourceManifest } from "../repository/supported-template";
import { hasTestCapability } from "../testing/test-capability";

type ReviewedWorkflow = Extract<AppBuilderWorkflowState, { phase: "reviewed" }>;

/**
 * Re-observes the validated apply overlay once, then exposes only exact file
 * postimages to the publication runtime. No bytes are retained in workflow or
 * durable publication state.
 */
const sha256 = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

export function publicationContentSourceForReviewedWorkflow(input: {
  state: ReviewedWorkflow;
  sandbox: SandboxSession;
}): GitHubPublicationContentSource {
  const relativeRoot = input.state.applyReceipt.applyRoot.replace(
    /^\/workspace\//u,
    "",
  );
  let applyFiles:
    | Promise<Map<string, { path: string; mode: string; digest: string }>>
    | undefined;
  const observeApplyFiles = () =>
    (applyFiles ??= (async () => {
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
      return new Map(observed.files.map((file) => [file.path, file]));
    })());
  return {
    async readFreshTree() {
      const prepared = await inspectSourceBoundSandboxWorkspace({
        sandbox: input.sandbox,
        receipt: input.state.sourceReceipt,
        expectedWorkspace: input.state.workspace,
        githubSource: input.state.githubSource,
      });
      const sourceFiles = await readPreparedSandboxSourceManifest(
        input.sandbox,
        prepared,
      );
      const files = await Promise.all(
        sourceFiles.map(async (file) => {
          const bytes = await input.sandbox.readBinaryFile({
            path: `repository/${file.path}`,
          });
          if (bytes === null || sha256(bytes) !== file.sha256)
            throw new Error(
              "A prepared source file changed before publication.",
            );
          return {
            path: file.path,
            mode: file.mode as "100644" | "100755",
            objectId: file.objectId,
            digest: file.sha256,
            bytes,
          };
        }),
      );
      await inspectSourceBoundSandboxWorkspace({
        sandbox: input.sandbox,
        receipt: input.state.sourceReceipt,
        expectedWorkspace: input.state.workspace,
        githubSource: input.state.githubSource,
      });
      return {
        version: 1 as const,
        kind: "fresh-repository-source-tree" as const,
        sourceSha: prepared.sourceSha,
        sourceTree: prepared.sourceTree,
        files,
      };
    },
    async readFile(path) {
      const files = await observeApplyFiles();
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
