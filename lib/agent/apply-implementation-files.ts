import { z } from "zod";

import type { ApplyCommandExecutor } from "@/lib/repository/target-apply";
import type { TargetProposal } from "@/lib/repository/target-planning";
import { runSequentially } from "@/lib/async-sequential";

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
      content: z.string(),
      path: implementationFilePathSchema,
    }),
  )
  .superRefine((files, context) => {
    const paths = new Set<string>();
    for (const [index, file] of files.entries()) {
      if (paths.has(file.path)) {
        context.addIssue({
          code: "custom",
          message: "Implementation file paths must be unique.",
          path: [index, "path"],
        });
      }
      paths.add(file.path);
    }
  });

export type ImplementationFile = z.infer<typeof implementationFilesSchema>[number];

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function assertExistingAppImplementationFiles(
  files: readonly ImplementationFile[],
  proposal: TargetProposal,
) {
  if (
    "operation" in proposal &&
    proposal.operation === "iterate-existing-app" &&
    files.some((file) => !file.path.startsWith(`${proposal.plan.source.workspacePath}/`))
  ) {
    throw new Error("Existing-app implementation files must stay inside the app workspace.");
  }
}

/** Submission-only heuristics are advisory; repository and behavior checks own validation. */
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function implementationArchitectureDiagnostics(
  files: readonly ImplementationFile[],
  schemaKind: "kernel" | "none",
) {
  const diagnostics: string[] = [];
  if (schemaKind !== "kernel") {
    return diagnostics;
  }
  const applicationFiles = files.filter((file) => /(?:^|\/)app\//u.test(file.path));
  const hasServerWrite = applicationFiles.some(
    (file) =>
      /^\s*["']use server["']/mu.test(file.content) ||
      /(?:^|\/)route\.[cm]?[jt]s$/u.test(file.path),
  );
  if (!hasServerWrite) {
    diagnostics.push(
      "No Server Action or route handler was recognized in the submitted files. Verify the complete app has the server-authorized persistence required by the accepted design.",
    );
  }
  const clientPersistence = applicationFiles.find(
    (file) =>
      /^\s*["']use client["']/mu.test(file.content) &&
      /localStorage|sessionStorage/u.test(file.content),
  );
  if (clientPersistence) {
    diagnostics.push(
      `${clientPersistence.path} references browser storage. Verify it holds only transient presentation state and durable writes use the server-owned store.`,
    );
  }
  const clientRoute = applicationFiles.find(
    (file) =>
      /(?:^|\/)(?:page|layout|template)\.[cm]?[jt]sx?$/u.test(file.path) &&
      /^\s*["']use client["']/mu.test(file.content),
  );
  if (clientRoute) {
    diagnostics.push(
      `${clientRoute.path} is a Client Component. Review server-rendered initial state and narrow interactive leaves where appropriate.`,
    );
  }
  return diagnostics;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function withImplementationFiles(
  executor: ApplyCommandExecutor,
  files: readonly ImplementationFile[],
): ApplyCommandExecutor {
  return async (input) => {
    assertExistingAppImplementationFiles(files, input.proposal);
    const relativeApplyRoot = input.applyRoot.replace(/^\/workspace\//u, "");
    const cuePath = `.config/app-specs/${input.appId}.cue`;
    const cue = files.find((file) => file.path === cuePath);
    if (cue !== undefined) {
      await input.sandbox.writeTextFile({
        content: cue.content,
        path: `${relativeApplyRoot}/${cue.path}`,
      });
    }
    const result = await executor(input);
    if (result.exitCode !== 0) {
      return result;
    }

    await runSequentially(
      files.filter((file) => file.path !== cuePath),
      async (file) => {
        await input.sandbox.writeTextFile({
          content: file.content,
          path: `${relativeApplyRoot}/${file.path}`,
        });
      },
    );
    return result;
  };
}
