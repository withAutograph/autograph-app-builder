type PlatformAuthenticatorCapability = {
  isUserVerifyingPlatformAuthenticatorAvailable?: () => Promise<boolean>;
};

/**
 * Prefer the device authenticator when the browser confirms one is available.
 * Omitting the attachment keeps Better Auth's platform/cross-platform fallback.
 */
export async function preferredPasskeyAuthenticatorAttachment(
  capability:
    PlatformAuthenticatorCapability | undefined = typeof PublicKeyCredential ===
  "undefined"
    ? undefined
    : PublicKeyCredential,
): Promise<"platform" | undefined> {
  if (!capability?.isUserVerifyingPlatformAuthenticatorAvailable) {
    return undefined;
  }

  try {
    return (await capability.isUserVerifyingPlatformAuthenticatorAvailable())
      ? "platform"
      : undefined;
  } catch {
    return undefined;
  }
}
