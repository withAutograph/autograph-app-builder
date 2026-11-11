import { z } from "zod";

import type { ApplyCommandExecutor } from "@/lib/repository/target-apply";
import type { TargetProposal } from "@/lib/repository/target-planning";
import {
  applicationFileChangeSchema,
  applyApplicationFileChanges,
} from "../repository/application-file-change";
import { workspaceBinInstallCommand } from "../repository/workspace-bin-install";

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

const generatedRuntime = "@autograph/generated-app-runtime";
const packageManifest = z.looseObject({
  dependencies: z.record(z.string(), z.string()).optional(),
});

const parsePackageManifest = (content: string | null) => {
  if (content === null) {
    return null;
  }
  try {
    return packageManifest.parse(JSON.parse(content));
  } catch {
    // The repository's install or validation command diagnoses malformed manifests.
    return null;
  }
};

/** A replacement manifest retains the runtime selected by the repository's CUE scaffold. */
const preserveGeneratedRuntime = async (input: {
  files: ImplementationFile[];
  path: string;
  root: string;
  sandbox: Parameters<ApplyCommandExecutor>[0]["sandbox"];
}): Promise<ImplementationFile[]> => {
  const file = input.files.find(({ path }) => path === input.path);
  if (file === undefined || file.operation === "delete") {
    return input.files;
  }
  const authored = parsePackageManifest(file.content);
  if (authored === null || authored.dependencies?.[generatedRuntime] !== undefined) {
    return input.files;
  }
  const generated = parsePackageManifest(
    await input.sandbox.readTextFile({ path: `${input.root}/${input.path}` }),
  );
  const specifier = generated?.dependencies?.[generatedRuntime];
  if (specifier === undefined) {
    return input.files;
  }
  authored.dependencies = { ...authored.dependencies, [generatedRuntime]: specifier };
  const content = `${JSON.stringify(authored, null, 2)}\n`;
  return input.files.map((change) => (change === file ? { ...file, content } : change));
};

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function assertExistingAppImplementationFiles(
  files: readonly ImplementationFile[],
  proposal:
    | TargetProposal
    | { operation: "iterate-existing-app"; plan: { source: { workspacePath: string } } },
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
  options?: { reconcileNewWorkspace: boolean },
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

    const reconcileNewWorkspace =
      options?.reconcileNewWorkspace === true && !("operation" in input.proposal);
    let authoredFiles = files.filter((file) => file.path !== cuePath);
    if (
      reconcileNewWorkspace &&
      ((cue !== undefined && cue.operation !== "delete") ||
        input.proposal.plan.source.schema.kind === "kernel")
    ) {
      authoredFiles = await preserveGeneratedRuntime({
        files: authoredFiles,
        path: `${input.proposal.plan.source.workspacePath}/package.json`,
        root: relativeApplyRoot,
        sandbox: input.sandbox,
      });
    }
    await applyApplicationFileChanges(input.sandbox, relativeApplyRoot, authoredFiles);
    if (reconcileNewWorkspace) {
      // The generator and approved file writes can both change the workspace graph.
      const install = await input.sandbox.run({
        command: workspaceBinInstallCommand(input.applyRoot, false),
        workingDirectory: input.applyRoot,
      });
      if (install.exitCode !== 0) {
        return { ...install, failedCommand: "bun install" };
      }
    }
    return result;
  };
}
