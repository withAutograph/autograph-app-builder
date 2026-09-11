import { sha256, TOOL_NAMES } from "../../scripts/portable-release";

export type ReleaseEvaluation =
  "sandbox-reviewed-change-set" | "sandbox-existing-iteration";

export function assertExactToolDiscovery(tools: readonly string[]) {
  if (JSON.stringify(tools) !== JSON.stringify(TOOL_NAMES))
    throw new Error(
      "Fresh portable clients did not discover five public tools.",
    );
}

export function parseReviewedProof<const Evaluation extends ReleaseEvaluation>(
  output: string,
  evaluation: Evaluation,
) {
  const terminal = [...output.matchAll(/\{[^\n]+\}/gu)]
    .map(([value]) => {
      try {
        return JSON.parse(value) as Record<string, unknown>;
      } catch {
        return undefined;
      }
    })
    .findLast(
      (value) =>
        value?.terminalPhase === "reviewed" &&
        value.publicationAttempted === false &&
        value.browserPreview === true,
    );
  if (terminal === undefined)
    throw new Error(
      `${evaluation} did not produce the reviewed proof receipt.`,
    );
  return {
    eval: evaluation,
    terminalPhase: "reviewed",
    browserPreview: true,
    publicationAttempted: false,
    outputSha256: sha256(output),
  } as const;
}
