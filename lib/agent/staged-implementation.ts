import { defineState } from "eve/context";
import type { ImplementationFile } from "./apply-implementation-files";

interface StagedImplementation {
  appSpecDigest: string;
  files: readonly ImplementationFile[];
  proposalDigest: string;
}

const stagedImplementation = defineState<StagedImplementation | null>(
  "autograph-app-builder.staged-implementation.v1",
  () => null,
);

/** Read the exact proposed submission without staging unapproved files. */
export const previewStagedImplementationFiles = (
  input: StagedImplementation,
): ImplementationFile[] => {
  const previous = stagedImplementation.get();
  const files = new Map<string, ImplementationFile>();
  if (
    previous?.appSpecDigest === input.appSpecDigest &&
    previous.proposalDigest === input.proposalDigest
  ) {
    for (const file of previous.files) {
      files.set(file.path, file);
    }
  }
  for (const file of input.files) {
    files.set(file.path, { ...file });
  }
  return [...files.values()];
};

/** Retain approved submissions across repair attempts without writing the source workspace. */
export const stageImplementationFiles = (input: StagedImplementation): ImplementationFile[] => {
  const merged = previewStagedImplementationFiles(input);
  stagedImplementation.update(() => ({ ...input, files: merged }));
  return merged;
};

/** The app-local schema is the compiled source when both supported paths were submitted. */
export const newAppImplementationSchema = (
  appId: string,
  files: readonly ImplementationFile[],
  workspacePath = `apps/${appId}`,
) => {
  const cueSourcePath = `.config/app-specs/${appId}.cue`;
  const schemaCuePath = `${workspacePath}/schema/${appId}.cue`;
  const sourceCue = files.find((file) => file.path === cueSourcePath);
  const appCue = files.find((file) => file.path === schemaCuePath);
  return { cueSourcePath, schemaCuePath, sourceCue, appCue };
};

/** The creation executor uses the same input before running the repository task. */
export const newAppImplementationSchemaKind = (
  appId: string,
  sourceKind: "kernel" | "none",
  files: readonly ImplementationFile[],
  workspacePath?: string,
) => {
  const { sourceCue, appCue } = newAppImplementationSchema(appId, files, workspacePath);
  const cue = appCue ?? sourceCue;
  if (cue === undefined) {
    return sourceKind;
  }
  return cue.operation === "delete" ? "none" : "kernel";
};
