import { z } from "zod";

import type { ApplyCommandExecutor } from "@/lib/repository/target-apply";
import type { TargetProposal } from "@/lib/repository/target-planning";
import {
  applicationFileChangeSchema,
  applyApplicationFileChanges,
} from "../repository/application-file-change";

export { applyApplicationFileChanges as applyImplementationFiles } from "../repository/application-file-change";

export const implementationFilesSchema = z
  .array(applicationFileChangeSchema)
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

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function assertImplementationArchitecture(
  files: readonly ImplementationFile[],
  schemaKind: "kernel" | "none",
) {
  if (schemaKind !== "kernel") {
    return;
  }
  const applicationFiles = files.filter(
    (file): file is Extract<ImplementationFile, { content: string }> =>
      file.operation !== "delete" && /(?:^|\/)app\//u.test(file.path),
  );
  const hasServerWrite = applicationFiles.some(
    (file) =>
      /^\s*["']use server["']/mu.test(file.content) ||
      /(?:^|\/)route\.[cm]?[jt]s$/u.test(file.path),
  );
  if (!hasServerWrite) {
    throw new Error(
      "This app owns durable data, but its implementation has no Server Action or route handler. Add the server-authorized write path required by the accepted product design.",
    );
  }
  const clientPersistence = applicationFiles.find(
    (file) =>
      /^\s*["']use client["']/mu.test(file.content) &&
      /localStorage|sessionStorage/u.test(file.content),
  );
  if (clientPersistence) {
    throw new Error(
      `This app owns durable data, but ${clientPersistence.path} uses browser storage as application persistence. Keep only transient presentation state in the browser and use the server-owned store.`,
    );
  }
  const clientRoute = applicationFiles.find(
    (file) =>
      /(?:^|\/)(?:page|layout|template)\.[cm]?[jt]sx?$/u.test(file.path) &&
      /^\s*["']use client["']/mu.test(file.content),
  );
  if (clientRoute) {
    throw new Error(
      `Keep ${clientRoute.path} as a Server Component and move interaction into a narrow client leaf.`,
    );
  }
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
      await applyApplicationFileChanges(input.sandbox, relativeApplyRoot, [cue]);
    }
    const result = await executor(input);
    if (result.exitCode !== 0) {
      return result;
    }

    await applyApplicationFileChanges(
      input.sandbox,
      relativeApplyRoot,
      files.filter((file) => file.path !== cuePath),
    );
    return result;
  };
}
