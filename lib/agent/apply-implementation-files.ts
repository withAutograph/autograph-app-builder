import { z } from "zod";

import type { ApplyCommandExecutor } from "@/lib/repository/target-apply";
import type { TargetProposal } from "@/lib/repository/target-planning";
import {
  applicationFileChangeSchema,
  applyApplicationFileChanges,
} from "../repository/application-file-change";
import { workspaceBinInstallCommand } from "../repository/workspace-bin-install";
import { newAppImplementationSchema } from "./staged-implementation";

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
  devDependencies: z.record(z.string(), z.string()).optional(),
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

const foundationDependencies = {
  dependencies: [generatedRuntime, "@autograph/auth", "@autograph/platform-microfrontends", "pg"],
  devDependencies: ["@autograph/next-config", "@types/pg"],
} as const;

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
  if (authored === null) {
    return input.files;
  }
  const generated = parsePackageManifest(
    await input.sandbox.readTextFile({ path: `${input.root}/${input.path}` }),
  );
  if (generated?.dependencies?.[generatedRuntime] === undefined) {
    return input.files;
  }
  let changed = false;
  for (const section of ["dependencies", "devDependencies"] as const) {
    const additions = Object.fromEntries(
      foundationDependencies[section].flatMap((name) => {
        const specifier = generated[section]?.[name];
        const authoredSpecifier = authored.dependencies?.[name] ?? authored.devDependencies?.[name];
        return authoredSpecifier === undefined && specifier !== undefined
          ? [[name, specifier]]
          : [];
      }),
    );
    if (Object.keys(additions).length > 0) {
      authored[section] = { ...authored[section], ...additions };
      changed = true;
    }
  }
  if (!changed) {
    return input.files;
  }
  const content = `${JSON.stringify(authored, null, 2)}\n`;
  return input.files.map((change) => (change === file ? { ...file, content } : change));
};

const preserveGeneratedFoundation = async (input: {
  files: ImplementationFile[];
  workspacePath: string;
  root: string;
  sandbox: Parameters<ApplyCommandExecutor>[0]["sandbox"];
  schemaCuePath?: string;
}): Promise<ImplementationFile[]> => {
  const { sandbox, root, workspacePath } = input;
  const boundaryPath = `${workspacePath}/app/data/protected-config.ts`;
  const nextConfigPath = `${workspacePath}/next.config.ts`;
  const earlierNextConfigs = new Set([
    `${workspacePath}/next.config.js`,
    `${workspacePath}/next.config.mjs`,
  ]);
  const generatedPaths = new Set([
    boundaryPath,
    `${workspacePath}/app/data/context.ts`,
    nextConfigPath,
    `${workspacePath}/proxy.ts`,
  ]);
  if (input.schemaCuePath !== undefined) {
    generatedPaths.add(input.schemaCuePath);
  }
  // Next resolves these alternate names before the generator's TypeScript config.
  const generatedPathFor = (file: ImplementationFile) =>
    file.operation !== "delete" && earlierNextConfigs.has(file.path) ? nextConfigPath : file.path;
  const collisions = new Set<string>();
  for (const file of input.files) {
    const path = generatedPathFor(file);
    if (generatedPaths.has(path)) {
      collisions.add(path);
    }
  }
  if (collisions.size === 0) {
    return input.files;
  }
  const boundary = await sandbox.readTextFile({ path: `${root}/${boundaryPath}` });
  if (boundary === null || !boundary.includes("readProtectedAppBoundary")) {
    return input.files;
  }
  const found = await Promise.all(
    [...collisions].map(async (path) => ({
      path,
      content:
        path === boundaryPath ? boundary : await sandbox.readTextFile({ path: `${root}/${path}` }),
    })),
  );
  const retained = new Set(found.filter(({ content }) => content !== null).map(({ path }) => path));
  return input.files.filter((file) => !retained.has(generatedPathFor(file)));
};

/** Temporarily present an app-local CUE to generators that select their foundation at the root. */
const executeWithCreationSchema = async (
  executor: ApplyCommandExecutor,
  input: Parameters<ApplyCommandExecutor>[0],
  root: string,
  schema: ReturnType<typeof newAppImplementationSchema>,
) => {
  const { sandbox } = input;
  const { appCue, sourceCue, cueSourcePath } = schema;
  if (appCue === undefined) {
    if (sourceCue !== undefined) {
      await applyApplicationFileChanges(sandbox, root, [sourceCue]);
    }
    return await executor(input);
  }
  const path = `${root}/${cueSourcePath}`;
  const previous = sourceCue === undefined ? await sandbox.readBinaryFile({ path }) : null;
  try {
    await applyApplicationFileChanges(sandbox, root, [{ ...appCue, path: cueSourcePath }]);
    return await executor(input);
  } finally {
    if (sourceCue !== undefined) {
      await applyApplicationFileChanges(sandbox, root, [sourceCue]);
    } else if (previous === null) {
      await sandbox.removePath({ force: true, path });
    } else {
      await sandbox.writeBinaryFile({ content: previous, path });
    }
  }
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
    const { workspacePath, schema: plannedSchema } = input.proposal.plan.source;
    const creationSchema =
      "operation" in input.proposal
        ? undefined
        : newAppImplementationSchema(input.appId, files, workspacePath);
    const result =
      creationSchema === undefined
        ? await executor(input)
        : await executeWithCreationSchema(executor, input, relativeApplyRoot, creationSchema);
    if (result.exitCode !== 0) {
      return result;
    }

    const reconcileNewWorkspace =
      options?.reconcileNewWorkspace === true && creationSchema !== undefined;
    let authoredFiles = files.filter(({ path }) => path !== creationSchema?.cueSourcePath);
    const cue = creationSchema?.appCue ?? creationSchema?.sourceCue;
    const persistent =
      cue === undefined ? plannedSchema?.kind === "kernel" : cue.operation !== "delete";
    if (reconcileNewWorkspace && persistent) {
      authoredFiles = await preserveGeneratedFoundation({
        files: authoredFiles,
        workspacePath,
        root: relativeApplyRoot,
        sandbox: input.sandbox,
        schemaCuePath:
          creationSchema.appCue === undefined ? undefined : creationSchema.schemaCuePath,
      });
      authoredFiles = await preserveGeneratedRuntime({
        files: authoredFiles,
        path: `${workspacePath}/package.json`,
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
