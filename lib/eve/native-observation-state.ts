import { z } from "zod";
import {
  publicInputRequestSchema,
  publicUiPreviewSchema,
  publicWorkingPreviewSchema,
  sessionStatusSchema,
} from "../mcp/contracts";
import {
  installedPrototypeProjectorStateSchema,
  installedPrototypeReferenceStateSchema,
} from "./public-events";

export const artifactReadbackStateSchema = z.strictObject({
  incompleteArtifacts: z.array(z.string()),
  incompleteUiPreviews: z.array(z.string()),
  legacy: z.boolean(),
  markdownCalls: z.array(z.tuple([z.string(), z.string()])),
  pending: z.array(
    z.tuple([z.string(), z.strictObject({ input: z.json(), toolName: z.string() })]),
  ),
  references: installedPrototypeReferenceStateSchema,
});
export type ArtifactReadbackState = z.infer<typeof artifactReadbackStateSchema>;

/** Private reducer checkpoint. Public event cursors never substitute for this native stream index. */
export const nativeObservationStateSchema = z.strictObject({
  adapterSessionId: z.string().min(1),
  artifactReadback: artifactReadbackStateSchema,
  boundary: sessionStatusSchema,
  currentTurnId: z.string().optional(),
  invalidInput: z.boolean(),
  nextNativeIndex: z.number().int().nonnegative(),
  pendingRequests: z.array(publicInputRequestSchema),
  prototypeProjector: installedPrototypeProjectorStateSchema,
  prototypeReference: installedPrototypeReferenceStateSchema,
  publicEventCount: z.number().int().nonnegative(),
  uiPreview: publicUiPreviewSchema.optional(),
  version: z.literal(1),
  workingPreview: publicWorkingPreviewSchema.nullable().optional(),
});
export type NativeObservationState = z.infer<typeof nativeObservationStateSchema>;
