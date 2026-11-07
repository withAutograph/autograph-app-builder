import { z } from "zod";

const id = z.string().min(1);
const pair = z.strictObject({
  from: z.literal("preview"),
  sourceProjectId: id,
  targetProjectId: id,
  to: z.literal("preview"),
});
/** Independent administrator evidence, never a claim that the operator integration can read host policy. */
export const externallyManagedTrustedSourcesSchema = z.strictObject({
  appPreview: pair,
  gatewayPreview: pair,
  mode: z.literal("externally-managed-trusted-sources"),
  observedAt: z.iso.datetime({ offset: true }),
  provenance: z.strictObject({ kind: z.literal("administrator-provider-readback"), reference: id }),
  teamId: id,
});
export type ExternallyManagedTrustedSources = z.infer<typeof externallyManagedTrustedSourcesSchema>;
export const matchesExternalTrustedSources = (
  policy: ExternallyManagedTrustedSources,
  teamId: string,
  appProjectId: string,
  gatewayProjectId: string,
) => {
  if (
    policy.teamId !== teamId ||
    appProjectId === gatewayProjectId ||
    policy.appPreview.sourceProjectId !== gatewayProjectId
  ) {
    return false;
  }
  return (
    policy.appPreview.targetProjectId === appProjectId &&
    policy.gatewayPreview.sourceProjectId === appProjectId &&
    policy.gatewayPreview.targetProjectId === gatewayProjectId
  );
};
