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

/** The creation executor applies this exact scaffold input before running the repository task. */
export const newAppImplementationSchemaKind = (
  appId: string,
  sourceKind: "kernel" | "none",
  files: readonly ImplementationFile[],
) => {
  const cuePath = `.config/app-specs/${appId}.cue`;
  const cue = files.find((file) => file.path === cuePath);
  if (cue === undefined) {
    return sourceKind;
  }
  return cue.operation === "delete" ? "none" : "kernel";
};
