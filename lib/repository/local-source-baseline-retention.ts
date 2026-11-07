import { readLocalOperatorArtifactAuthority } from "../provisioning/local-operator-artifact-store";
import { captureLocalPlanningSource } from "./local-planning-source-capture";
import { retainLocalSourceBaseline } from "./local-source-baseline-store";
import type { retainLocalSourceBaseline as RetainLocalSourceBaseline } from "./local-source-baseline-store";
import type { inspectDevelopmentSourceGeneration } from "./development-source-generation";

interface CapturedLocalBaselineSource {
  generation: { workspaceDigest: string; sourceSha: string };
  capturedBase: () => {
    sourceSha: string;
    sourceTree: string;
    streamPack: () => ReadableStream<Uint8Array>;
  };
  dispose: () => void;
}
/** Retain the exact new live planning input before its workspace receipt can freeze. */
export const retainPreparedLocalSourceBaseline = async (
  expected: Awaited<ReturnType<typeof inspectDevelopmentSourceGeneration>>,
  dependencies: {
    readAuthority?: typeof readLocalOperatorArtifactAuthority;
    capture?: (sourcePath: string, sourceSha: string) => Promise<CapturedLocalBaselineSource>;
    captured?: CapturedLocalBaselineSource;
    retain?: typeof RetainLocalSourceBaseline;
  } = {},
) => {
  const authority = await (dependencies.readAuthority ?? readLocalOperatorArtifactAuthority)();
  if (authority === undefined) {
    return;
  }
  const capture =
    dependencies.captured ??
    (await (dependencies.capture ?? captureLocalPlanningSource)(
      expected.sourcePath,
      expected.sourceSha,
    ));
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
        kind: "local-planning-source-baseline",
        originalSourceSha: expected.sourceSha,
        provenance: { kind: "captured-live-source", sourcePath: expected.sourcePath },
        sourceSha: baseline.sourceSha,
        sourceTree: baseline.sourceTree,
        version: 1,
        workspaceDigest: expected.workspaceDigest,
      },
      pack: baseline.streamPack(),
    });
  } finally {
    if (dependencies.captured === undefined) {
      capture.dispose();
    }
  }
};
