import { z } from "zod";

import type { ApplyCommandExecutor } from "@/lib/repository/target-apply";

const implementationFilePathSchema = z
  .string()
  .min(1)
  .superRefine((value, context) => {
    if (value.startsWith("/") || value.includes("\\") || value.includes("\0")) {
      context.addIssue({
        code: "custom",
        message: "Implementation file paths must be relative POSIX paths.",
      });
      return;
    }
    if (value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
      context.addIssue({
        code: "custom",
        message: "Implementation file paths must stay inside the repository checkout.",
      });
    }
  });

export const implementationFilesSchema = z
  .array(
    z.strictObject({
      path: implementationFilePathSchema,
      content: z.string(),
    }),
  )
  .superRefine((files, context) => {
    const paths = new Set<string>();
    for (const [index, file] of files.entries()) {
      if (paths.has(file.path)) {
        context.addIssue({
          code: "custom",
          path: [index, "path"],
          message: "Implementation file paths must be unique.",
        });
      }
      paths.add(file.path);
    }
  });

export type ImplementationFile = z.infer<typeof implementationFilesSchema>[number];

export function withImplementationFiles(
  executor: ApplyCommandExecutor,
  files: readonly ImplementationFile[],
): ApplyCommandExecutor {
  return async (input) => {
    const result = await executor(input);
    if (result.exitCode !== 0) {
      return result;
    }

    const relativeApplyRoot = input.applyRoot.replace(/^\/workspace\//u, "");
    for (const file of files) {
      await input.sandbox.writeTextFile({
        path: `${relativeApplyRoot}/${file.path}`,
        content: file.content,
      });
    }
    return result;
  };
}
