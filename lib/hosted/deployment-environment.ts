import { z } from "zod";

export const hostedDeploymentEnvironmentSchema = z.enum([
  "preview",
  "production",
]);

export type HostedDeploymentEnvironment = z.infer<
  typeof hostedDeploymentEnvironmentSchema
>;

const hostedDeploymentEnvironmentBindingSchema = z
  .object({
    configuredEnvironment: hostedDeploymentEnvironmentSchema,
    hostedAdapter: z.literal("1"),
    vercelEnvironment: hostedDeploymentEnvironmentSchema,
  })
  .strict()
  .superRefine((binding, context) => {
    if (binding.vercelEnvironment !== binding.configuredEnvironment) {
      context.addIssue({
        code: "custom",
        message:
          "The configured hosted environment must exactly match VERCEL_ENV.",
        path: ["configuredEnvironment"],
      });
    }
  });

/**
 * Returns the one exact supported deployment environment only after the
 * explicit App Builder binding agrees with Vercel's invocation environment.
 */
export function readHostedDeploymentEnvironment(
  environment: Readonly<Record<string, string | undefined>>
): HostedDeploymentEnvironment {
  const parsed = hostedDeploymentEnvironmentBindingSchema.safeParse({
    configuredEnvironment: environment.EVE_HOSTED_VERCEL_ENVIRONMENT,
    hostedAdapter: environment.EVE_HOSTED_ADAPTER,
    vercelEnvironment: environment.VERCEL_ENV,
  });
  if (!parsed.success) {
    throw new Error(
      "The hosted deployment requires one exact matching Preview or Production environment binding."
    );
  }
  return parsed.data.configuredEnvironment;
}
