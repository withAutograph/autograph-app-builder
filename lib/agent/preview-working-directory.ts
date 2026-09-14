import nodePath from "node:path";
import { z } from "zod";

export const previewWorkingDirectorySchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) => !nodePath.posix.isAbsolute(value) && !value.includes("\\") && !value.includes("\0"),
    "Preview working directory must be a relative POSIX path.",
  )
  .default(".");

/** Resolve command location without imposing a repository layout or probing source files. */
export const resolvePreviewWorkingDirectory = (root: string, workingDirectory: string): string => {
  const relativeDirectory = previewWorkingDirectorySchema.parse(workingDirectory);
  const resolvedRoot = nodePath.posix.resolve(root);
  const resolved = nodePath.posix.resolve(resolvedRoot, relativeDirectory);
  const relative = nodePath.posix.relative(resolvedRoot, resolved);
  if (relative === ".." || relative.startsWith("../")) {
    throw new Error("Preview working directory must stay inside the applied repository checkout.");
  }
  return resolved;
};
