import type { Observation } from "./self-reproduction-parity";
import { runtimeReceiptSchema } from "./self-reproduction-parity-evidence";

/** Merge candidate runtime fallback with trusted receipts without duplicating requirement rows. */
export const mergeRuntimeEvidence = (input: {
  trustedReceipts: readonly unknown[];
  candidateFallback: readonly Observation[];
}): unknown[] => {
  const invalid: unknown[] = [];
  const receipts = new Map<string, unknown>();
  const dispositions = new Map<string, string>();
  for (const receipt of input.trustedReceipts) {
    const parsed = runtimeReceiptSchema.safeParse(receipt);
    if (!parsed.success) {
      // Preserve invalid evidence for the report validator rather than hiding it.
      invalid.push(receipt);
      continue;
    }
    const { side, observation } = parsed.data;
    const key = `${side}/${observation.requirementId}`;
    if (!receipts.has(key) || dispositions.get(key) === "not-run") {
      receipts.set(key, receipt);
      dispositions.set(key, observation.disposition);
    }
  }
  for (const observation of input.candidateFallback) {
    const key = `candidate/${observation.requirementId}`;
    if (
      receipts.has(key) &&
      (dispositions.get(key) !== "not-run" || observation.disposition === "not-run")
    )
      continue;
    receipts.set(key, {
      observation,
      producer: "evaluator",
      schemaVersion: "self-reproduction-runtime-receipt/v1",
      side: "candidate",
    });
    dispositions.set(key, observation.disposition);
  }
  return [...invalid, ...receipts.values()];
};
