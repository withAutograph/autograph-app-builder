import { defineState } from "eve/context";
import type { ImplementationFile } from "./apply-implementation-files";

interface StagedImplementation {
  appSpecDigest: string;
  files: ImplementationFile[];
  proposalDigest: string;
}

const stagedImplementation = defineState<StagedImplementation | null>(
  "autograph-app-builder.staged-implementation.v1",
  () => null,
);

/** Retain approved submissions across repair attempts without writing the source workspace. */
export const stageImplementationFiles = (input: StagedImplementation): ImplementationFile[] => {
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
  const merged = [...files.values()];
  stagedImplementation.update(() => ({ ...input, files: merged }));
  return merged;
};
