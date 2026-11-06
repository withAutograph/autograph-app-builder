import { z } from "zod";

export const hostedDeploymentEnvironmentSchema = z.enum(["preview", "production"]);

export type HostedDeploymentEnvironment = z.infer<typeof hostedDeploymentEnvironmentSchema>;

const hostedDeploymentEnvironmentBindingSchema = z.object({
  configuredEnvironment: hostedDeploymentEnvironmentSchema,
  hostedAdapter: z.literal("1"),
  vercelEnvironment: hostedDeploymentEnvironmentSchema,
});

/**
 * Returns the one exact supported deployment environment only after the
 * explicit App Builder binding agrees with Vercel's invocation environment.
 */
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function readHostedDeploymentEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): HostedDeploymentEnvironment {
  const binding = {
    configuredEnvironment: environment.EVE_HOSTED_VERCEL_ENVIRONMENT,
    hostedAdapter: environment.EVE_HOSTED_ADAPTER,
    vercelEnvironment: environment.VERCEL_ENV,
  };
  const parsed = hostedDeploymentEnvironmentBindingSchema.safeParse(binding);
  if (!parsed.success) {
    throw new Error(
      "The hosted deployment requires one exact matching Preview or Production environment binding.",
    );
  }
  if (parsed.data.vercelEnvironment !== parsed.data.configuredEnvironment) {
    throw new Error(
      "The hosted deployment requires one exact matching Preview or Production environment binding.",
    );
  }
  return parsed.data.configuredEnvironment;
}
