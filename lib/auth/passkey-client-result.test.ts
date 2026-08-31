import { describe, expect, it } from "vitest";

import {
  createPasskeyAuthenticationBoundary,
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
  it("offers Sign Up for a user-mediated failure that returned no assertion", () => {
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
      offerSignUp: true,
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
      offerSignUp: false,
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
      offerSignUp: false,
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
      offerSignUp: false,
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
      offerSignUp: false,
    });
  });

  it("offers Sign Up for a structural NotAllowedError even when Better Auth loses its code", async () => {
    const boundary = createPasskeyAuthenticationBoundary();
    const originalGet = async () => {
      throw { name: "NotAllowedError", message: "No credential available." };
    };
    const credentials = { get: originalGet } as unknown as CredentialsContainer;
    const restore = boundary.observeCredentialGet(credentials);

    await expect(credentials.get({})).rejects.toMatchObject({
      name: "NotAllowedError",
    });
    restore();

    expect(
      boundary.failure({
        data: null,
        error: {
          code: "AUTH_CANCELLED",
          message: "Passkey authentication was cancelled.",
        },
      }),
    ).toMatchObject({
      assertionStatus: "not-returned",
      code: "ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY",
      offerSignUp: true,
    });
    expect(credentials.get).toBe(originalGet);
  });

  it("offers Sign Up when the credential API resolves without an assertion", async () => {
    const boundary = createPasskeyAuthenticationBoundary();
    const credentials = {
      get: async () => null,
    } as unknown as CredentialsContainer;
    const restore = boundary.observeCredentialGet(credentials);
    await expect(credentials.get({})).resolves.toBeNull();
    restore();

    expect(
      boundary.failure({
        data: null,
        error: {
          code: "AUTH_CANCELLED",
          message: "Passkey authentication was cancelled.",
        },
      }),
    ).toMatchObject({
      assertionStatus: "not-returned",
      code: "ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY",
      offerSignUp: true,
    });
  });

  it("preserves assertion evidence when Better Auth drops it after transport loss", async () => {
    const boundary = createPasskeyAuthenticationBoundary();
    const credential = {
      id: "credential-id",
      type: "public-key",
    } as Credential;
    const credentials = {
      get: async () => credential,
    } as unknown as CredentialsContainer;
    const restore = boundary.observeCredentialGet(credentials);

    await expect(credentials.get({})).resolves.toBe(credential);
    restore();

    expect(
      boundary.failure({
        data: null,
        error: {
          code: "AUTH_CANCELLED",
          message: "Passkey authentication was cancelled.",
        },
      }),
    ).toMatchObject({
      assertionStatus: "returned",
      code: "AUTH_CANCELLED",
      offerSignUp: false,
    });
  });

  it("keeps a structural SecurityError on Sign In", async () => {
    const boundary = createPasskeyAuthenticationBoundary();
    const credentials = {
      get: async () => {
        throw { name: "SecurityError", message: "RP ID mismatch." };
      },
    } as unknown as CredentialsContainer;
    const restore = boundary.observeCredentialGet(credentials);
    await expect(credentials.get({})).rejects.toMatchObject({
      name: "SecurityError",
    });
    restore();

    expect(
      boundary.failure({
        data: null,
        error: {
          code: "AUTH_CANCELLED",
          message: "Passkey authentication was cancelled.",
        },
      }),
    ).toMatchObject({
      assertionStatus: "not-returned",
      code: "AUTH_CANCELLED",
      offerSignUp: false,
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
      offerSignUp: false,
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
