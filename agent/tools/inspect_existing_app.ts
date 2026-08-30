import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";

import {
  appBuilderWorkflowState,
  validAppId,
} from "@/lib/agent/workflow-state";
import { canInspectExistingApplication } from "@/lib/agent/existing-app-sequencing";
import { safeSourcePath } from "@/lib/repository/source-path";

const maximumFileBytes = 262_144;
const maximumTotalBytes = 1_048_576;

export default defineDynamic({
  events: {
    "step.started": () => {
      if (!canInspectExistingApplication(appBuilderWorkflowState.get()))
        return null;
      return defineTool({
        description:
          "After source and workspace preparation, read a bounded set of regular text files from one existing application in the immutable prepared source. First call with no paths to list app-owned files, then call with the selected paths to obtain exact preimages for replacement drafting. This is a read-only implementation-planning operation and never writes or publishes.",
        inputSchema: z.strictObject({
          appId: z.string().min(1),
          paths: z.array(z.string().min(1).max(512)).max(32).default([]),
        }),
        async execute({ appId, paths }, ctx) {
          if (!validAppId(appId))
            throw new Error("The existing application id is invalid.");
          const state = appBuilderWorkflowState.get();
          if (!canInspectExistingApplication(state))
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
          for (const path of paths) {
            if (!allowed.has(path))
              throw new Error(
                "An existing application source file is unavailable.",
              );
            const content = await sandbox.readTextFile({
              path: `repository/${path}`,
            });
            if (content === null)
              throw new Error(
                "An existing application source file is unavailable.",
              );
            const size = Buffer.byteLength(content);
            total += size;
            if (size > maximumFileBytes || total > maximumTotalBytes)
              throw new Error(
                "The existing application inspection exceeded its bounded size.",
              );
            files.push({ path, content });
          }
          return { appId, availablePaths, files };
        },
      });
    },
  },
});
