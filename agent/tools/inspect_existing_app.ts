import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";

import {
  appBuilderWorkflowState,
  validAppId,
} from "@/lib/agent/workflow-state";
import { sourceWorkflowState } from "@/lib/agent/source-state";
import { canInspectExistingApplication } from "@/lib/agent/existing-app-sequencing";
import { inspectSourceBoundSandboxWorkspace } from "@/lib/repository/arrusted-template";
import { safeSourcePath } from "@/lib/repository/source-path";
import sourceStatus from "./source_status";
import prepareWorkspace from "./prepare_workspace";

const maximumFileBytes = 262_144;
const maximumTotalBytes = 1_048_576;

export default defineDynamic({
  events: {
    "step.started": () => {
      return defineTool({
        description:
          "Read regular text files from one existing application. A fresh canonical-source flow prepares itself automatically. First call with no paths to list app-owned files, then request the smallest relevant set, normally one to six files at a time. Missing new-file candidates and files omitted from one response are reported without failing the whole read. This is a read-only implementation-planning operation and never writes or publishes.",
        inputSchema: z.strictObject({
          appId: z.string().min(1),
          paths: z.array(z.string().min(1).max(512)).max(32).default([]),
        }),
        async execute({ appId, paths }, ctx) {
          if (!validAppId(appId))
            throw new Error("The existing application id is invalid.");
          let state = appBuilderWorkflowState.get();
          // The canonical Arrusted starter is already the supported transport
          // for its built-in applications. Make inspection self-starting so a
          // fresh existing-app conversation does not need to know the internal
          // source/setup sequence. Arbitrary repositories still require the
          // explicit source resolution path.
          if (state.phase === "empty") {
            await sourceStatus.execute({}, ctx);
            const source = sourceWorkflowState.get();
            if (source.phase === "empty")
              throw new Error("The canonical source could not be prepared.");
            await prepareWorkspace.execute(
              { expectedSourceReceiptDigest: source.receipt.digest },
              ctx,
            );
            state = appBuilderWorkflowState.get();
          }
          if (state.phase === "empty" || !canInspectExistingApplication(state))
            throw new Error("Prepare the source before inspection.");
          const prefix = `apps/${appId}/`;
          if (
            new Set(paths).size !== paths.length ||
            paths.some(
              (path) => !safeSourcePath(path) || !path.startsWith(prefix),
            )
          )
            throw new Error(
              "An existing application inspection path is not allowed.",
            );
          const sandbox = await ctx.getSandbox();
          await inspectSourceBoundSandboxWorkspace({
            sandbox,
            receipt: state.sourceReceipt,
            expectedWorkspace: state.workspace,
            ...(state.githubSource === undefined
              ? {}
              : { githubSource: state.githubSource }),
          });
          const manifestSource = await sandbox.readTextFile({
            path: ".app-builder/source-files.json",
          });
          if (manifestSource === null)
            throw new Error("Prepared source manifest is missing.");
          const manifest = JSON.parse(manifestSource) as unknown;
          if (!Array.isArray(manifest))
            throw new Error("Prepared source manifest is invalid.");
          const allowed = new Set(
            manifest.flatMap((candidate): string[] =>
              typeof candidate === "object" &&
              candidate !== null &&
              "path" in candidate &&
              typeof candidate.path === "string"
                ? [candidate.path]
                : [],
            ),
          );
          const availablePaths = [...allowed]
            .filter((path) => path.startsWith(prefix))
            .sort()
            .slice(0, 512);
          if (availablePaths.length === 0)
            throw new Error(
              "The requested existing application does not exist.",
            );
          let total = 0;
          const files = [];
          const missingPaths = [];
          const omittedPaths = [];
          for (const path of paths) {
            if (!allowed.has(path)) {
              missingPaths.push(path);
              continue;
            }
            const content = await sandbox.readTextFile({
              path: `repository/${path}`,
            });
            if (content === null) {
              missingPaths.push(path);
              continue;
            }
            const size = Buffer.byteLength(content);
            if (size > maximumFileBytes || total + size > maximumTotalBytes) {
              omittedPaths.push(path);
              continue;
            }
            total += size;
            files.push({ path, content });
          }
          return {
            appId,
            availablePaths,
            files,
            ...(missingPaths.length === 0 ? {} : { missingPaths }),
            ...(omittedPaths.length === 0 ? {} : { omittedPaths }),
          };
        },
      });
    },
  },
});
