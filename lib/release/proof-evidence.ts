import { sha256, TOOL_NAMES } from "../../scripts/portable-release";

export type ReleaseEvaluation = "sandbox-reviewed-change-set" | "sandbox-existing-iteration";

interface ReviewedTerminal {
  browserPreview: true;
  publicationAttempted: false;
  terminalPhase: "reviewed";
}

const isReviewedTerminal = (value: unknown): value is ReviewedTerminal => {
  if (typeof value !== "object" || value === null) return false;
  if (!("terminalPhase" in value) || value.terminalPhase !== "reviewed") return false;
  if (!("publicationAttempted" in value) || value.publicationAttempted !== false) return false;
  return "browserPreview" in value && value.browserPreview === true;
};

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function assertExactToolDiscovery(tools: readonly string[]) {
  if (JSON.stringify(tools) !== JSON.stringify(TOOL_NAMES)) {
    throw new Error("Fresh portable clients did not discover five public tools.");
  }
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function parseReviewedProof<const Evaluation extends ReleaseEvaluation>(
  output: string,
  evaluation: Evaluation,
) {
  const terminal = [...output.matchAll(/\{[^\n]+\}/gu)]
    .map(([value]) => {
      try {
        const parsed: unknown = JSON.parse(value);
        return isReviewedTerminal(parsed) ? parsed : null;
      } catch {
        return null;
      }
    })
    .findLast((candidate) => candidate !== null);
  if (terminal === undefined) {
    throw new Error(`${evaluation} did not produce the reviewed proof receipt.`);
  }
  return {
    browserPreview: true,
    eval: evaluation,
    outputSha256: sha256(output),
    publicationAttempted: false,
    terminalPhase: "reviewed",
  } as const;
}
