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
    if (value.split("/").some((segment) => segment === "" || segment === "." || segment === ".."))
      context.addIssue({
        code: "custom",
        message: "Implementation file paths must stay inside the repository checkout.",
      });
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
      if (paths.has(file.path))
        context.addIssue({
          code: "custom",
          path: [index, "path"],
          message: "Implementation file paths must be unique.",
        });
      paths.add(file.path);
    }
  });

export type ImplementationFile = z.infer<typeof implementationFilesSchema>[number];

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function assertImplementationArchitecture(
  files: readonly ImplementationFile[],
  schemaKind: "kernel" | "none",
) {
  if (schemaKind !== "kernel") return;
  const applicationFiles = files.filter((file) => /(?:^|\/)app\//u.test(file.path));
  const hasServerWrite = applicationFiles.some(
    (file) =>
      /^\s*["']use server["']/mu.test(file.content) ||
      /(?:^|\/)route\.[cm]?[jt]s$/u.test(file.path),
  );
  if (!hasServerWrite)
    throw new Error(
      "This app owns durable data, but its implementation has no Server Action or route handler. Add the server-authorized write path required by the accepted product design.",
    );
  const clientPersistence = applicationFiles.find(
    (file) =>
      /^\s*["']use client["']/mu.test(file.content) &&
      /localStorage|sessionStorage/u.test(file.content),
  );
  if (clientPersistence)
    throw new Error(
      `This app owns durable data, but ${clientPersistence.path} uses browser storage as application persistence. Keep only transient presentation state in the browser and use the server-owned store.`,
    );
  const clientRoute = applicationFiles.find(
    (file) =>
      /(?:^|\/)(?:page|layout|template)\.[cm]?[jt]sx?$/u.test(file.path) &&
      /^\s*["']use client["']/mu.test(file.content),
  );
  if (clientRoute)
    throw new Error(
      `Keep ${clientRoute.path} as a Server Component and move interaction into a narrow client leaf.`,
    );
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function withImplementationFiles(
  executor: ApplyCommandExecutor,
  files: readonly ImplementationFile[],
): ApplyCommandExecutor {
  return async (input) => {
    const result = await executor(input);
    if (result.exitCode !== 0) return result;

    const relativeApplyRoot = input.applyRoot.replace(/^\/workspace\//u, "");
    for (const file of files)
      // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
      await input.sandbox.writeTextFile({
        path: `${relativeApplyRoot}/${file.path}`,
        content: file.content,
      });
    return result;
  };
}
