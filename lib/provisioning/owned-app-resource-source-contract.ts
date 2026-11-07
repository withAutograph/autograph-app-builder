import { z } from "zod";

const id = z.string().min(1);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
/** Credential provenance only; every revision still requires its own concrete resource approval. */
export const ownedAppResourceSourceSchema = z.strictObject({
  kind: z.literal("owned-app-resources-v1"),
  scopeDigest: digest,
  source: z.strictObject({
    checkpointSha256: digest,
    operationRef: z.uuid(),
    planDigest: digest,
    target: z.strictObject({
      appId: id,
      branch: id,
      environment: z.literal("preview"),
      installationId: id,
      projectId: id,
      scopeId: id,
      scopeType: z.literal("team"),
      sessionId: id,
    }),
  }),
});
export type OwnedAppResourceSource = z.infer<typeof ownedAppResourceSourceSchema>;
