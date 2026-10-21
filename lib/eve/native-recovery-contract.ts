import { z } from "zod";

/** Private server binding. Public MCP inputs never accept native run authority. */
export const nativeRecoveryDescriptorSchema = z.strictObject({
  version: z.literal(1),
  operationId: z.string().min(1),
  sourcePublicSessionId: z.string().min(1),
  sourceOwnerRunId: z.string().min(1),
  sourceAdapterGeneration: z.number().int().positive(),
  logicalSessionId: z.string().min(1),
  originalAuthoritySessionId: z.string().min(1),
  parentCancellationRevision: z.number().int().nonnegative(),
  sourceHandoffId: z.uuid().optional(),
});
export type NativeRecoveryDescriptor = z.infer<typeof nativeRecoveryDescriptorSchema>;

export const nativeRecoveryBindingSchema = nativeRecoveryDescriptorSchema
  .extend({
    ownerRunId: z.string().min(1),
    provenance: z.strictObject({
      kind: z.enum([
        "terminal-finalizer-input",
        "completed-terminal-turn-input",
        "failed-turn-input",
        "committed-turn-output",
      ]),
      sourceStepId: z.string().min(1),
      sourceEventId: z.string().min(1),
      sourceSlot: z.number().int().nonnegative(),
      checkpointVersion: z.literal(1),
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
