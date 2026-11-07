import { z } from "zod";

import {
  captureStates,
  desktopViewports,
  observationSchema,
  parityEvidenceSchema,
  parityVersion,
  requirements,
  sides,
} from "./self-reproduction-parity";
import type { Observation, ParityEvidence } from "./self-reproduction-parity";

const side = z.enum(sides);
const requirementIds: string[] = [];
const runtimeRequirementIds = new Set<string>();
for (const row of requirements) {
  requirementIds.push(row.id);
  if (row.kind !== "capture") {
    runtimeRequirementIds.add(row.id);
  }
}
const requirementId = z.enum(requirementIds);

export const runtimeReceiptSchema = z
  .strictObject({
    observation: observationSchema,
    producer: z.literal("evaluator"),
    schemaVersion: z.literal("self-reproduction-runtime-receipt/v1"),
    side,
  })
  .superRefine((value, ctx) => {
    if (!runtimeRequirementIds.has(value.observation.requirementId)) {
      ctx.addIssue({
        code: "custom",
        message: "Runtime receipts cannot claim capture requirements",
      });
    }
  });
export const captureReceiptSchema = z
  .strictObject({
    artifacts: observationSchema.shape.artifacts,
    assertions: observationSchema.shape.assertions,
    disposition: z.enum([
      "observed",
      "missing-functionality",
      "infrastructure-unavailable",
      "not-run",
    ]),
    method: observationSchema.shape.method,
    reason: z.string().min(1),
    requirementId,
    side,
    state: z.enum(captureStates),
    viewport: z.object({
      height: z.number().int().positive(),
      name: z.enum(["desktop", "desktop-wide", "desktop-window"]),
      width: z.number().int().positive(),
    }),
  })
  .superRefine((value, ctx) => {
    const expected = `capture/${value.viewport.name}/${value.state}`;
    if (value.requirementId !== expected) {
      ctx.addIssue({ code: "custom", message: `Capture identity must be ${expected}` });
    }
    const configured = desktopViewports.find((item) => item.name === value.viewport.name);
    if (configured?.width !== value.viewport.width || configured.height !== value.viewport.height) {
      ctx.addIssue({
        code: "custom",
        message: "Capture viewport does not match the parity matrix",
      });
    }
  })
  .transform((receipt) => ({
    observation: {
      artifacts: receipt.artifacts,
      assertions: receipt.assertions,
      disposition: receipt.disposition,
      method: receipt.method,
      reason: receipt.reason,
      requirementId: receipt.requirementId,
    },
    side: receipt.side,
  }));

export interface EvidenceSideInput {
  output: "available" | "missing" | "infrastructure-unavailable";
  reason: string;
  sourceRevision: string;
}

export interface ParityReceiptInput {
  runId: string;
  reference: EvidenceSideInput;
  candidate: EvidenceSideInput;
  runtimeReceipts?: readonly unknown[];
  captureReceipts?: readonly unknown[];
}

// Converts evaluator-owned receipts into the sole observation shape accepted by
// assessParity. Candidate-authored summaries never enter this boundary.
export const parityEvidenceFromReceipts = (input: ParityReceiptInput): ParityEvidence => {
  const observations: Record<(typeof sides)[number], Observation[]> = {
    candidate: [],
    reference: [],
  };
  for (const raw of input.runtimeReceipts ?? []) {
    const receipt = runtimeReceiptSchema.parse(raw);
    observations[receipt.side].push(receipt.observation);
  }
  for (const raw of input.captureReceipts ?? []) {
    const receipt = captureReceiptSchema.parse(raw);
    observations[receipt.side].push(receipt.observation);
  }
  return parityEvidenceSchema.parse({
    candidate: { ...input.candidate, observations: observations.candidate },
    fixtureVersion: 1,
    producer: "evaluator",
    reference: { ...input.reference, observations: observations.reference },
    runId: input.runId,
    schemaVersion: parityVersion,
  });
};
