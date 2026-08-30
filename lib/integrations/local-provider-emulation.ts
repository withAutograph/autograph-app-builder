import { z } from "zod";

const localOrigin = z
  .string()
  .url()
  .transform((value, context) => {
    const url = new URL(value);
    const local =
      (url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) ||
      (url.protocol === "https:" &&
        url.hostname.endsWith(".emulate.localhost"));
    if (!local || url.pathname !== "/" || url.search || url.hash)
      context.addIssue({
        code: "custom",
        message: "Emulator origin must be a loopback origin.",
      });
    return url.origin;
  });

export type LocalProviderEmulation = {
  vercelOrigin: string;
  githubOrigin: string;
  token: string;
  githubRepository: string;
};

/** The only development transport override. It is unavailable in deployed code. */
export function readLocalProviderEmulation(
  environment: Readonly<Record<string, string | undefined>>,
): LocalProviderEmulation | undefined {
  if (environment.APP_BUILDER_LOCAL_PROVIDER_EMULATION === undefined)
    return undefined;
  if (
    environment.APP_BUILDER_LOCAL_PROVIDER_EMULATION !== "1" ||
    environment.NODE_ENV === "production" ||
    environment.VERCEL_ENV !== undefined
  )
    throw new Error("Local provider emulation is unavailable.");
  return z
    .object({
      vercelOrigin: localOrigin,
      githubOrigin: localOrigin,
      token: z.string().min(20).max(512),
      githubRepository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u),
    })
    .strict()
    .parse({
      vercelOrigin: environment.VERCEL_EMULATOR_URL,
      githubOrigin: environment.GITHUB_EMULATOR_URL,
      token: environment.EMULATE_PROVIDER_TOKEN,
      githubRepository: environment.EMULATE_GITHUB_REPOSITORY,
    });
}
