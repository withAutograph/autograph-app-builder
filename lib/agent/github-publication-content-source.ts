import type { SandboxSession } from "eve/sandbox";
import { createHash } from "node:crypto";

import type { AppBuilderWorkflowState } from "./workflow-state";
import type { GitHubPublicationContentSource } from "../repository/github-publication";
import {
  inspectApplyOverlay,
  inspectFixtureApplyOverlay,
} from "../repository/target-apply";
import { inspectPreparedSandboxWorkspace } from "../repository/supported-template";
import { safeSourcePath } from "../repository/source-path";
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
      const prepared = await inspectPreparedSandboxWorkspace(input.sandbox);
      if (
        prepared.state !== "prepared" ||
        prepared.workspace.sourceSha !== input.state.workspace.sourceSha ||
        prepared.workspace.sourceTree !== input.state.workspace.sourceTree ||
        prepared.workspace.workspaceDigest !==
          input.state.workspace.workspaceDigest
      )
        throw new Error(
          "The prepared source workspace changed before publication.",
        );
      const raw = await input.sandbox.readTextFile({
        path: ".app-builder/source-files.json",
      });
      if (raw === null)
        throw new Error("The prepared source manifest is missing.");
      const parsed: unknown = JSON.parse(raw);
      if (
        !Array.isArray(parsed) ||
        sha256(JSON.stringify(parsed)) !== prepared.workspace.workspaceDigest
      )
        throw new Error(
          "The prepared source manifest changed before publication.",
        );
      const files = await Promise.all(
        parsed.map(async (candidate) => {
          if (
            typeof candidate !== "object" ||
            candidate === null ||
            Array.isArray(candidate) ||
            Object.keys(candidate).toSorted().join("\0") !==
              ["mode", "objectId", "path", "sha256"].toSorted().join("\0")
          )
            throw new Error("The prepared source manifest is invalid.");
          const file = candidate as Record<string, unknown>;
          if (
            (file.mode !== "100644" && file.mode !== "100755") ||
            typeof file.objectId !== "string" ||
            !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(file.objectId) ||
            typeof file.path !== "string" ||
            !safeSourcePath(file.path) ||
            typeof file.sha256 !== "string" ||
            !/^[0-9a-f]{64}$/u.test(file.sha256)
          )
            throw new Error("The prepared source manifest is invalid.");
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
      return {
        version: 1 as const,
        kind: "fresh-repository-source-tree" as const,
        sourceSha: prepared.workspace.sourceSha,
        sourceTree: prepared.workspace.sourceTree,
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
