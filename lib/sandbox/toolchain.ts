import { isHostedVercelRuntime } from "./backend";

export const TOOLCHAIN_IMAGE_ENV = "APP_BUILDER_SANDBOX_IMAGE";

export const requiredToolVersions = {
  git: /^git version \d+\.\d+\.\d+/u,
  mise: /^2026\.8\.12(?:\s|$)/u,
  bun: /^1\.3\.14(?:\s|$)/u,
} as const;

export type RequiredTool = keyof typeof requiredToolVersions;

const digestPinnedImage = /@sha256:[0-9a-f]{64}$/u;
const contentKeyedDevelopmentImage =
  /^app-builder-autograph-dev:[0-9a-f]{64}-[0-9a-f]{16}-linux-(?:arm64|amd64)$/u;

/**
 * A registry reference is accepted only when an external image build has
 * resolved it to an immutable OCI manifest digest. Image construction and
 * acquisition are deliberately outside the agent runtime.
 */
export function configuredToolchainImage(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  const image = environment[TOOLCHAIN_IMAGE_ENV]?.trim();
  if (image === undefined || image === "") return undefined;
  const development = environment.APP_BUILDER_EXECUTION_MODE === "development";
  if (development && !contentKeyedDevelopmentImage.test(image))
    throw new Error(
      `${TOOLCHAIN_IMAGE_ENV} must use the content-keyed local development image name.`,
    );
  if (!development && !digestPinnedImage.test(image))
    throw new Error(
      `${TOOLCHAIN_IMAGE_ENV} must be an OCI image reference pinned with @sha256:<64 lowercase hex characters>.`,
    );
  // Eve 0.43's supported Vercel backend fixes its VCR image and strips
  // author-supplied image/runtime fields. A GHCR reference is therefore local
  // microsandbox authority only.
  if (isHostedVercelRuntime(environment)) return undefined;
  return image;
}

export function toolVersionMatches(
  tool: RequiredTool,
  version: string,
): boolean {
  return requiredToolVersions[tool].test(version);
}

export function sandboxRevalidationKey(
  image: string | undefined,
  backend = "local",
): string {
  return `autograph-app-builder-toolchain-v2:${backend}:${image ?? "unconfigured"}`;
}
