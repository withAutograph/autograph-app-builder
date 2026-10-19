import { z } from "zod";

const id = z.string().min(1);
const pair = z.strictObject({
  sourceProjectId: id,
  targetProjectId: id,
  from: z.literal("preview"),
  to: z.literal("preview"),
});
/** Independent administrator evidence, never a claim that the operator integration can read host policy. */
export const externallyManagedTrustedSourcesSchema = z.strictObject({
  mode: z.literal("externally-managed-trusted-sources"),
  teamId: id,
  appPreview: pair,
  gatewayPreview: pair,
  observedAt: z.iso.datetime({ offset: true }),
  provenance: z.strictObject({ kind: z.literal("administrator-provider-readback"), reference: id }),
});
export type ExternallyManagedTrustedSources = z.infer<typeof externallyManagedTrustedSourcesSchema>;
export const matchesExternalTrustedSources = (
  policy: ExternallyManagedTrustedSources,
  teamId: string,
  appProjectId: string,
  gatewayProjectId: string,
) =>
  policy.teamId === teamId &&
  appProjectId !== gatewayProjectId &&
  policy.appPreview.sourceProjectId === gatewayProjectId &&
  policy.appPreview.targetProjectId === appProjectId &&
  policy.gatewayPreview.sourceProjectId === appProjectId &&
  policy.gatewayPreview.targetProjectId === gatewayProjectId;
