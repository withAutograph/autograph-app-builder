export const TOOLCHAIN_IMAGE_ENV = "APP_BUILDER_SANDBOX_IMAGE";

export const requiredToolVersions = {
  git: /^git version \d+\.\d+\.\d+/u,
  mise: /^2026\.8\.12(?:\s|$)/u,
  bun: /^1\.2\.20(?:\s|$)/u,
} as const;

export type RequiredTool = keyof typeof requiredToolVersions;

const digestPinnedImage = /@sha256:[0-9a-f]{64}$/u;

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
  if (!digestPinnedImage.test(image))
    throw new Error(
      `${TOOLCHAIN_IMAGE_ENV} must be an OCI image reference pinned with @sha256:<64 lowercase hex characters>.`,
    );
  return image;
}

export function toolVersionMatches(
  tool: RequiredTool,
  version: string,
): boolean {
  return requiredToolVersions[tool].test(version);
}

export function sandboxRevalidationKey(image: string | undefined): string {
  return `autograph-app-builder-toolchain-v1:${image ?? "unconfigured"}`;
}
