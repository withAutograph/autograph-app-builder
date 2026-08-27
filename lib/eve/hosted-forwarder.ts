import { vercelSubject } from "eve/channels/auth";
import { z } from "zod";

const hostedForwarderConfigSchema = z
  .object({
    teamSlug: z
      .string()
      .min(1)
      .max(100)
      .refine((value) => !/[*:]/u.test(value)),
    projectName: z
      .string()
      .min(1)
      .max(100)
      .refine((value) => !/[*:]/u.test(value)),
    environment: z.literal("preview"),
  })
  .strict();

export function readHostedForwarderSubject(
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>,
): string | undefined {
  if (environment.EVE_HOSTED_ADAPTER !== "1") return undefined;
  const config = hostedForwarderConfigSchema.parse({
    teamSlug: environment.EVE_HOSTED_VERCEL_TEAM_SLUG,
    projectName: environment.EVE_HOSTED_VERCEL_PROJECT_NAME,
    environment: environment.EVE_HOSTED_VERCEL_ENVIRONMENT,
  });
  return vercelSubject(config);
}
