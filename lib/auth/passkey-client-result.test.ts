import { describe, expect, it } from "vitest";

import {
  passkeyAuthenticationFailure,
  passkeyClientError,
  withPasskeyUnavailable,
} from "./passkey-client-result";
import {
  isPasskeyOnboardingAlreadyAuthenticated,
  PASSKEY_ONBOARDING_ALREADY_AUTHENTICATED,
  passkeyErrorCode,
} from "./passkey-contract";

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
      assertionStatus: "not-returned",
      code: "ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY",
      redirectToSignUp: true,
    });
  });

  it.each([
    "PASSKEY_NOT_FOUND",
    "AUTHENTICATION_FAILED",
    "CHALLENGE_NOT_FOUND",
  ])("keeps a resolved %s server rejection on Sign In", (code) => {
    expect(
      passkeyAuthenticationFailure({
        data: null,
        error: { code, message: "Passkey authentication failed." },
        webauthn: { response: { id: "credential-id" } },
      }),
    ).toMatchObject({
      assertionStatus: "returned",
      code,
      redirectToSignUp: false,
    });
  });

  it("lets returned assertion evidence override a passthrough code", () => {
    expect(
      passkeyAuthenticationFailure({
        data: null,
        error: {
          code: "ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY",
          message: "Passkey authentication failed.",
        },
        webauthn: { response: { id: "credential-id" } },
      }),
    ).toMatchObject({
      assertionStatus: "returned",
      redirectToSignUp: false,
    });
  });

  it.each([
    "CHALLENGE_NOT_FOUND",
    "ERROR_CEREMONY_ABORTED",
    "ERROR_INVALID_DOMAIN",
    "ERROR_INVALID_RP_ID",
    "ERROR_AUTHENTICATOR_GENERAL_ERROR",
    "UNKNOWN_ERROR",
  ])("keeps %s on Sign In without an assertion", (code) => {
    expect(
      passkeyAuthenticationFailure({
        data: null,
        error: { code, message: "Passkey authentication failed." },
      }),
    ).toMatchObject({
      assertionStatus: "not-returned",
      code,
      redirectToSignUp: false,
    });
  });

  it("keeps ambiguous Better Auth cancellation envelopes on Sign In", () => {
    expect(
      passkeyAuthenticationFailure({
        data: null,
        error: {
          code: "AUTH_CANCELLED",
          message: "Passkey authentication was cancelled.",
        },
      }),
    ).toMatchObject({
      assertionStatus: "unknown",
      code: "AUTH_CANCELLED",
      redirectToSignUp: false,
    });
  });

  it("classifies code-less challenge or network responses as pre-assertion failures", () => {
    expect(
      passkeyAuthenticationFailure({
        data: null,
        error: { message: "Unable to generate a challenge." },
      }),
    ).toMatchObject({
      assertionStatus: "not-returned",
      redirectToSignUp: false,
    });
  });
});

describe("passkey onboarding conflict detection", () => {
  it("reads the conflict code from an onboarding HTTP response", () => {
    const response = {
      code: PASSKEY_ONBOARDING_ALREADY_AUTHENTICATED,
      message: "The current session is already authenticated.",
    };

    expect(passkeyErrorCode(response)).toBe(
      PASSKEY_ONBOARDING_ALREADY_AUTHENTICATED,
    );
    expect(isPasskeyOnboardingAlreadyAuthenticated(response)).toBe(true);
  });

  it("reads the conflict code from a Better Auth registration result", () => {
    const result = {
      data: null,
      error: {
        code: PASSKEY_ONBOARDING_ALREADY_AUTHENTICATED,
        message: "The current session is already authenticated.",
      },
    };

    expect(passkeyErrorCode(result)).toBe(
      PASSKEY_ONBOARDING_ALREADY_AUTHENTICATED,
    );
    expect(isPasskeyOnboardingAlreadyAuthenticated(result)).toBe(true);
  });

  it("reads the conflict code from a thrown BetterFetchError shape", () => {
    const error = Object.assign(new Error("Conflict"), {
      status: 409,
      statusText: "Conflict",
      error: {
        code: PASSKEY_ONBOARDING_ALREADY_AUTHENTICATED,
        message: "The current session is already authenticated.",
      },
    });

    expect(passkeyErrorCode(error)).toBe(
      PASSKEY_ONBOARDING_ALREADY_AUTHENTICATED,
    );
    expect(isPasskeyOnboardingAlreadyAuthenticated(error)).toBe(true);
  });

  it("does not infer the conflict from messages or unrelated codes", () => {
    expect(
      isPasskeyOnboardingAlreadyAuthenticated({
        code: "OTHER_ERROR",
        message: PASSKEY_ONBOARDING_ALREADY_AUTHENTICATED,
      }),
    ).toBe(false);
    expect(
      isPasskeyOnboardingAlreadyAuthenticated({
        error: { code: 409 },
      }),
    ).toBe(false);
    expect(passkeyErrorCode(null)).toBeUndefined();
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
