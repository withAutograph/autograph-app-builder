import { z } from "zod";

/** Private server binding. Public MCP inputs never accept native run authority. */
export const nativeRecoveryDescriptorSchema = z.strictObject({
  /** Explicit owner-requested transfer of a parked native execution, never a user cancellation. */
  executionTransfer: z
    .strictObject({
      kind: z.enum(["pending-approval", "idle-checkpoint"]),
      sourceCheckpointDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    })
    .optional(),
  logicalSessionId: z.string().min(1),
  operationId: z.string().min(1),
  originalAuthoritySessionId: z.string().min(1),
  parentCancellationRevision: z.number().int().nonnegative(),
  sourceAdapterGeneration: z.number().int().positive(),
  sourceHandoffId: z.uuid().optional(),
  sourceOwnerRunId: z.string().min(1),
  sourcePublicSessionId: z.string().min(1),
  version: z.literal(1),
});
export type NativeRecoveryDescriptor = z.infer<typeof nativeRecoveryDescriptorSchema>;

export const nativeRecoveryBindingSchema = nativeRecoveryDescriptorSchema
  .extend({
    ownerRunId: z.string().min(1),
    provenance: z.strictObject({
      checkpointOwnerRunId: z.string().min(1).optional(),
      checkpointVersion: z.literal(1),
      kind: z.enum([
        "terminal-finalizer-input",
        "completed-terminal-turn-input",
        "failed-turn-input",
        "committed-turn-output",
      ]),
      resumePhase: z.literal("await-input").optional(),
      sourceEventId: z.string().min(1),
      sourceSlot: z.number().int().nonnegative(),
      sourceStepId: z.string().min(1),
    }),
  })
  .superRefine((binding, context) => {
    if (binding.ownerRunId === binding.sourceOwnerRunId) {
      context.addIssue({ code: "custom", message: "Recovery needs its own physical execution." });
    }
  });
export type NativeRecoveryBinding = z.infer<typeof nativeRecoveryBindingSchema>;

export const sameNativeRecoveryDescriptor = (
  left: NativeRecoveryDescriptor,
  right: NativeRecoveryDescriptor,
): boolean =>
  JSON.stringify(nativeRecoveryDescriptorSchema.parse(left)) ===
  JSON.stringify(nativeRecoveryDescriptorSchema.parse(right));

export const assertNativeRecoveryReceipt = (
  descriptor: NativeRecoveryDescriptor,
  binding: NativeRecoveryBinding,
): void => {
  const { ownerRunId: _owner, provenance: _provenance, ...source } = binding;
  void _owner;
  void _provenance;
  if (!sameNativeRecoveryDescriptor(descriptor, source)) {
    throw new Error("Native recovery receipt differs from its canonical reservation.");
  }
};

/** Exact source coordinates for advisory native reads; never recovery or dispatch authority. */
export const nativeSourceObservationSchema = z.strictObject({
  cancellationRevision: z.number().int().nonnegative(),
  sourceAdapterGeneration: z.number().int().positive(),
  sourceAdapterSessionId: z.string().min(1),
  sourcePublicSessionId: z.string().min(1),
});
export type NativeSourceObservation = z.infer<typeof nativeSourceObservationSchema>;
