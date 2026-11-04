import { readLocalOperatorArtifactAuthority } from "../provisioning/local-operator-artifact-store";
import type { retainLocalSourceBaseline as RetainLocalSourceBaseline } from "./local-source-baseline-store";
import type { inspectDevelopmentSourceGeneration } from "./supported-template";

/** Retain the exact first live planning input before its workspace receipt can freeze. */
export const retainPreparedLocalSourceBaseline = async (
  expected: Awaited<ReturnType<typeof inspectDevelopmentSourceGeneration>>,
  dependencies: {
    readAuthority?: typeof readLocalOperatorArtifactAuthority;
    capture?: (
      sourcePath: string,
      sourceSha: string,
    ) => Promise<{
      generation: { workspaceDigest: string; sourceSha: string };
      capturedBase: () => {
        sourceSha: string;
        sourceTree: string;
        streamPack: () => ReadableStream<Uint8Array>;
      };
      dispose: () => void;
    }>;
    retain?: typeof RetainLocalSourceBaseline;
  } = {},
) => {
  const authority = await (dependencies.readAuthority ?? readLocalOperatorArtifactAuthority)();
  if (authority === undefined) {
    return;
  }
  const [{ captureLocalPlanningSource }, { retainLocalSourceBaseline }] = await Promise.all([
    import("./local-planning-source"),
    import("./local-source-baseline-store"),
  ]);
  const capture = await (dependencies.capture ?? captureLocalPlanningSource)(
    expected.sourcePath,
    expected.sourceSha,
  );
  try {
    if (
      capture.generation.workspaceDigest !== expected.workspaceDigest ||
      capture.generation.sourceSha !== expected.sourceSha
    ) {
      throw new Error(
        "The selected local source changed before its original baseline was retained. Prepare again; no workspace receipt was frozen.",
      );
    }
    const baseline = capture.capturedBase();
    await (dependencies.retain ?? retainLocalSourceBaseline)({
      authority,
      manifest: {
        version: 1,
        kind: "local-planning-source-baseline",
        originalSourceSha: expected.sourceSha,
        workspaceDigest: expected.workspaceDigest,
        sourceSha: baseline.sourceSha,
        sourceTree: baseline.sourceTree,
        provenance: { kind: "captured-live-source", sourcePath: expected.sourcePath },
      },
      pack: baseline.streamPack(),
    });
  } finally {
    capture.dispose();
  }
};
