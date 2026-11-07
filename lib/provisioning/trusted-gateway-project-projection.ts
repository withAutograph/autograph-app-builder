import { z } from "zod";

const projectionScope = {
  environment: z.literal("preview"),
  ownerId: z.string().min(1),
  projectId: z.string().min(1),
};
export const trustedGatewayAppBindingSchema = z.strictObject({
  appId: z.string().min(1),
  approved: z.strictObject({
    ...projectionScope,
    deploymentId: z.string().min(1),
    deploymentUrl: z.url(),
    projectName: z.string().min(1),
    scopeSlug: z.string().min(1),
  }),
  observation: z.strictObject({
    ...projectionScope,
    deploymentId: z.string().min(1),
    deploymentUrl: z.url(),
    projectName: z.string().min(1),
    readyState: z.literal("READY"),
    scopeSlug: z.string().min(1),
  }),
});
export const trustedGatewayProjectProjectionSchema = z.strictObject({
  bindings: z.array(trustedGatewayAppBindingSchema),
  provenance: z.literal("trusted-operator-published-provider-projection"),
  source: z.strictObject({
    ...projectionScope,
    audience: z.url(),
    issuer: z.url(),
    publicOrigin: z.url(),
    subject: z.string().min(1),
  }),
  version: z.literal(1),
});
export type TrustedGatewayProjectProjection = z.infer<typeof trustedGatewayProjectProjectionSchema>;
export type TrustedGatewayAppBinding = z.infer<typeof trustedGatewayAppBindingSchema>;

export const mergeTrustedGatewayAppBinding = (
  bindings: readonly TrustedGatewayAppBinding[],
  binding: TrustedGatewayAppBinding,
) => [...bindings.filter((entry) => entry.appId !== binding.appId), binding];
