import { describe, expect, it } from "vitest";

import { passkeyClientError } from "./passkey-client-result";
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
