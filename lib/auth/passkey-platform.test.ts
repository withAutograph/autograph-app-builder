import { describe, expect, it, vi } from "vitest";

import { preferredPasskeyAuthenticatorAttachment } from "./passkey-platform";

describe("preferredPasskeyAuthenticatorAttachment", () => {
  it("requests a platform authenticator when the browser reports one", async () => {
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    const isUserVerifyingPlatformAuthenticatorAvailable = vi.fn(async () => true);

    await expect(
      preferredPasskeyAuthenticatorAttachment({
        isUserVerifyingPlatformAuthenticatorAvailable,
      }),
    ).resolves.toBe("platform");
    expect(isUserVerifyingPlatformAuthenticatorAvailable).toHaveBeenCalledOnce();
  });

  it("keeps the unrestricted fallback when no platform authenticator is available", async () => {
    await expect(
      preferredPasskeyAuthenticatorAttachment({
        // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
        isUserVerifyingPlatformAuthenticatorAvailable: vi.fn(async () => false),
      }),
    ).resolves.toBeUndefined();
  });

  it("keeps the unrestricted fallback when capability detection fails", async () => {
    await expect(
      preferredPasskeyAuthenticatorAttachment({
        // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
        isUserVerifyingPlatformAuthenticatorAvailable: vi.fn(async () => {
          throw new DOMException("Unavailable", "NotSupportedError");
        }),
      }),
    ).resolves.toBeUndefined();
  });

  it.each([undefined, {}])(
    "keeps the unrestricted fallback when platform detection is unsupported",
    async (capability) => {
      await expect(preferredPasskeyAuthenticatorAttachment(capability)).resolves.toBeUndefined();
    },
  );
});
