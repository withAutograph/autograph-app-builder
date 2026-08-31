import { describe, expect, it } from "vitest";

import {
  passkeyAuthenticationFailure,
  passkeyClientError,
  withPasskeyUnavailable,
} from "./passkey-client-result";

describe("passkeyClientError", () => {
  it("accepts successful Better Auth passkey responses", () => {
    expect(
      passkeyClientError({ data: { session: {} }, error: null }),
    ).toBeNull();
  });

  it("turns resolved WebAuthn cancellation responses into errors", () => {
    const error = passkeyClientError({
      data: null,
      error: {
        code: "AUTH_CANCELLED",
        message: "Passkey authentication was cancelled.",
      },
    });

    expect(error).toMatchObject({
      name: "AUTH_CANCELLED",
      message: "Passkey authentication was cancelled.",
    });
  });

  it("does the same for a cancelled registration ceremony", () => {
    expect(
      passkeyClientError({
        data: null,
        error: { code: "ERROR_CEREMONY_ABORTED", message: "Cancelled." },
      }),
    ).toMatchObject({ name: "ERROR_CEREMONY_ABORTED", message: "Cancelled." });
  });
});

describe("passkeyAuthenticationFailure", () => {
  it("redirects a user-mediated failure that returned no assertion", () => {
    expect(
      passkeyAuthenticationFailure({
        data: null,
        error: {
          code: "ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY",
          message:
            "The operation was cancelled or no credential was available.",
        },
      }),
    ).toMatchObject({
      assertionReturned: false,
      code: "ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY",
      redirectToSignUp: true,
    });
  });

  it("keeps a rejected assertion on Sign In", () => {
    expect(
      passkeyAuthenticationFailure({
        data: null,
        error: { code: "PASSKEY_NOT_FOUND", message: "Passkey not found." },
        webauthn: { response: { id: "credential-id" } },
      }),
    ).toMatchObject({
      assertionReturned: true,
      code: "PASSKEY_NOT_FOUND",
      redirectToSignUp: false,
    });
  });

  it.each([
    "CHALLENGE_NOT_FOUND",
    "AUTH_CANCELLED",
    "ERROR_INVALID_RP_ID",
    "ERROR_AUTHENTICATOR_GENERAL_ERROR",
  ])("keeps %s on Sign In without an assertion", (code) => {
    expect(
      passkeyAuthenticationFailure({
        data: null,
        error: { code, message: "Passkey authentication failed." },
      }),
    ).toMatchObject({
      assertionReturned: false,
      code,
      redirectToSignUp: false,
    });
  });
});

describe("withPasskeyUnavailable", () => {
  it("preserves the complete redirect and marks the Sign Up context", () => {
    expect(
      withPasskeyUnavailable(
        "/auth/sign-up?redirectTo=%2Fauth%2Fsetting-up%3FcallbackURL%3D%252Fworkspace%253Fsource%253Dbrief",
      ),
    ).toBe(
      "/auth/sign-up?redirectTo=%2Fauth%2Fsetting-up%3FcallbackURL%3D%252Fworkspace%253Fsource%253Dbrief&passkey=unavailable",
    );
  });
});
