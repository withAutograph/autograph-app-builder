import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";

import { appBuilderWorkflowState } from "@/lib/agent/workflow-state";
import { sourceWorkflowState } from "@/lib/agent/source-state";
import { safeSourcePath } from "@/lib/repository/source-path";
import sourceStatus from "./source_status";
import prepareWorkspace from "./prepare_workspace";

const maximumFileBytes = 262_144;
const maximumTotalBytes = 1_048_576;

export default defineDynamic({
  events: {
    "step.started": () =>
      defineTool({
        description:
          "Read regular text files from one existing application. A fresh canonical-source flow prepares itself automatically. First call with no paths to list app-owned files, then request the smallest relevant set, normally one to six files at a time. Missing new-file candidates and files omitted from one response are reported without failing the whole read. This is a read-only implementation-planning operation and never writes or publishes.",
        async execute({ appId, paths }, ctx) {
          let state = appBuilderWorkflowState.get();
          // The canonical Arrusted starter is already the supported transport
          // for its built-in applications. Make inspection self-starting so a
          // fresh existing-app conversation does not need to know the internal
          // source/setup sequence. Arbitrary repositories still require the
          // explicit source resolution path.
          if (state.phase === "empty") {
            try {
              await sourceStatus.execute({}, ctx);
              const source = sourceWorkflowState.get();
              if (source.phase !== "empty") {
                await prepareWorkspace.execute({}, ctx);
              }
            } catch {
              // The session sandbox remains the authority for a best-effort
              // read of newly generated files, even before its workflow state
              // has caught up.
            }
            state = appBuilderWorkflowState.get();
          }
          const prefix = `apps/${appId}/`;
          if (!safeSourcePath(appId) || appId.includes("/")) {
            throw new Error("The requested application cannot be read safely.");
          }
          const requestedPaths = paths.flatMap((path) =>
            safeSourcePath(path) ? [path.startsWith(prefix) ? path : `${prefix}${path}`] : [],
          );
          const sandbox = await ctx.getSandbox();
          // The signed-in session supplies this sandbox. Read its current
          // files; source receipts are not prerequisites for inspection.
          const manifestSource = await sandbox.readTextFile({
            path: ".app-builder/source-files.json",
          });
          let manifest: unknown = [];
          try {
            manifest = manifestSource === null ? [] : JSON.parse(manifestSource);
          } catch {
            manifest = [];
          }
          const allowed = new Set(
            (Array.isArray(manifest) ? manifest : []).flatMap((candidate): string[] =>
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
            .toSorted()
            .slice(0, 512);
          let total = 0;
          const files: { content: string; path: string }[] = [];
          const missingPaths: string[] = [];
          const omittedPaths: string[] = [];
          const readRequestedPath = async (index: number): Promise<void> => {
            const path = requestedPaths[index];
            if (path === undefined) {
              return;
            }
            const content = await sandbox.readTextFile({
              path: `repository/${path}`,
            });
            if (content === null) {
              missingPaths.push(path);
              await readRequestedPath(index + 1);
              return;
            }
            const size = Buffer.byteLength(content);
            if (size > maximumFileBytes || total + size > maximumTotalBytes) {
              omittedPaths.push(path);
              await readRequestedPath(index + 1);
              return;
            }
            total += size;
            files.push({ content, path });
            await readRequestedPath(index + 1);
          };
          await readRequestedPath(0);
          return {
            appId,
            availablePaths,
            files,
            ...(missingPaths.length === 0 ? {} : { missingPaths }),
            ...(omittedPaths.length === 0 ? {} : { omittedPaths }),
          };
        },
        inputSchema: z.strictObject({
          appId: z.string().min(1),
          paths: z.array(z.string().min(1).max(512)).max(32).default([]),
        }),
      }),
  },
});
