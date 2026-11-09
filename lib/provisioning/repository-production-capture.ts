import { GENERATED_RELEASE_MEMBERS } from "./hosted-operator-sandbox-launcher";
import type { OperatorArtifactContext } from "./hosted-operator-artifact-store";
import type { createOperatorArtifactPublication } from "./hosted-operator-artifacts";
import type { RepositoryProductionRequestOwner } from "./repository-production-dispatcher";
import type { RepositoryProductionIntent } from "./repository-production-contract";
import type { RepositoryProductionCapture } from "./repository-production-management-subject";

type Storage = Extract<RepositoryProductionIntent["storage"], { kind: "postgres" }>;
type Selection = Parameters<
  ReturnType<typeof createOperatorArtifactPublication>["readGeneratedRelease"]
>[1];
type AssertOwner = () => Promise<void>;
interface CapturePorts {
  readSelection: (
    context: OperatorArtifactContext,
    storage: Storage,
    assertOwner: AssertOwner,
  ) => Promise<Selection | undefined>;
  readRelease: (
    context: OperatorArtifactContext,
    selection: Selection,
    assertOwner: AssertOwner,
  ) => Promise<RepositoryProductionCapture>;
}

const copyCapture = (capture: RepositoryProductionCapture): RepositoryProductionCapture => {
  const files = { ...capture.files };
  for (const name of GENERATED_RELEASE_MEMBERS) {
    files[name] = Buffer.from(capture.files[name]);
  }
  const copy: RepositoryProductionCapture = { artifactRef: capture.artifactRef, files };
  if (capture.description !== undefined) {
    copy.description = structuredClone(capture.description);
  }
  return copy;
};

const readCaptureCopy = async (
  ports: CapturePorts,
  context: OperatorArtifactContext,
  selection: Selection,
  assertOwner: AssertOwner,
) => copyCapture(await ports.readRelease(context, selection, assertOwner));

/** One request owns this reader; only verified immutable bytes may be reused. */
export const createRepositoryProductionCaptureReader = (ports: CapturePorts) => {
  const captures = new Map<string, Promise<RepositoryProductionCapture>>();
  return async (
    context: OperatorArtifactContext,
    storage: Storage,
    assertOwner: AssertOwner,
    owner: RepositoryProductionRequestOwner,
  ): Promise<RepositoryProductionCapture> => {
    // Selection, approval and current owner are not cached with the immutable content.
    const selection = await ports.readSelection(context, storage, assertOwner);
    if (
      !selection ||
      selection.releaseId !== storage.releaseId ||
      selection.manifestSha256 !== storage.manifestSha256
    ) {
      throw new Error("repository_production_capture_unavailable");
    }
    await assertOwner();
    const key = JSON.stringify({
      context,
      owner,
      selection: {
        artifactRef: selection.artifactRef,
        releaseId: selection.releaseId,
        manifestSha256: selection.manifestSha256,
        schemaSha256: selection.schemaSha256,
      },
    });
    let pending = captures.get(key);
    if (pending === undefined) {
      pending = readCaptureCopy(ports, context, selection, assertOwner);
      captures.set(key, pending);
    }
    try {
      const capture = await pending;
      await assertOwner();
      return copyCapture(capture);
    } catch (error) {
      if (captures.get(key) === pending) {
        captures.delete(key);
      }
      throw error;
    }
  };
};
