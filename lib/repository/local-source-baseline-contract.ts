import { z } from "zod";

export const localSourceBaselineManifestSchema = z.strictObject({
  version: z.literal(1),
  kind: z.literal("local-planning-source-baseline"),
  originalSourceSha: z.string().regex(/^[a-f0-9]{40}$/u),
  workspaceDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  sourceSha: z.string().regex(/^[a-f0-9]{40}$/u),
  sourceTree: z.string().regex(/^[a-f0-9]{40}$/u),
  provenance: z.record(z.string(), z.json()),
});
export type LocalSourceBaselineManifest = z.infer<typeof localSourceBaselineManifestSchema>;
