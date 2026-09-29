import type { SandboxSession } from "eve/sandbox";
import { z } from "zod";
import { safeSourcePath } from "./source-path";
import { runSequentially } from "../async-sequential";

const path = z
  .string()
  .min(1)
  .refine(
    (value) => safeSourcePath(value) && !value.includes("\0") && !value.split("/").includes(""),
    "File paths must stay inside the repository checkout.",
  );

/** Omitted operation preserves saved submissions from before explicit file operations. */
export const applicationFileChangeSchema = z.union([
  z.strictObject({ content: z.string(), operation: z.literal("upsert").optional(), path }),
  z.strictObject({ content: z.never().optional(), operation: z.literal("delete"), path }),
]);

export type ApplicationFileChange = z.infer<typeof applicationFileChangeSchema>;

/** Non-recursive deletion cannot remove an app directory or unrelated descendants. */
export const applyApplicationFileChanges = async (
  sandbox: Pick<SandboxSession, "writeTextFile" | "removePath">,
  root: string,
  changes: readonly ApplicationFileChange[],
): Promise<void> => {
  await runSequentially(changes, async (change) => {
    const target = `${root.replace(/^\/workspace\//u, "")}/${change.path}`;
    await (change.operation === "delete"
      ? sandbox.removePath({ force: true, path: target })
      : sandbox.writeTextFile({ content: change.content, path: target }));
  });
};
