type PasskeyClientError = {
  code?: unknown;
  message?: unknown;
};

const USER_MEDIATED_NO_ASSERTION_CODE = "ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY";
// Better Auth also emits this code when verification transport fails after the
// browser returned an assertion, but omits the WebAuthn response in that path.
const AMBIGUOUS_ASSERTION_CODE = "AUTH_CANCELLED";

export type PasskeyAssertionStatus = "returned" | "not-returned" | "unknown";

export type PasskeyAuthenticationFailure = {
  assertionStatus: PasskeyAssertionStatus;
  code?: string;
  error: Error;
  redirectToSignUp: boolean;
};

function passkeyResultError(result: unknown): PasskeyClientError | null {
  if (!result || typeof result !== "object" || !("error" in result)) {
    return null;
  }

  const error = (result as { error?: PasskeyClientError | null }).error;
  return error && typeof error === "object" ? error : null;
}

export function passkeyClientError(result: unknown): Error | null {
  const error = passkeyResultError(result);
  if (!error) return null;

  const message =
    typeof error.message === "string" && error.message
      ? error.message
      : "Passkey authentication could not be completed.";
  const clientError = new Error(message);
  if (typeof error.code === "string") clientError.name = error.code;
  return clientError;
}

export function passkeyAuthenticationFailure(
  result: unknown,
): PasskeyAuthenticationFailure | null {
  const resultError = passkeyResultError(result);
  const error = passkeyClientError(result);
  if (!resultError || !error) return null;

  const assertionStatus: PasskeyAssertionStatus =
    typeof result === "object" &&
    result !== null &&
    "webauthn" in result &&
    typeof result.webauthn === "object" &&
    result.webauthn !== null
      ? "returned"
      : resultError.code === AMBIGUOUS_ASSERTION_CODE
        ? "unknown"
        : "not-returned";
  const code =
    typeof resultError.code === "string" ? resultError.code : undefined;

  return {
    assertionStatus,
    ...(code ? { code } : {}),
    error,
    redirectToSignUp:
      assertionStatus === "not-returned" &&
      code === USER_MEDIATED_NO_ASSERTION_CODE,
  };
}

export function withPasskeyUnavailable(url: string) {
  const internalOrigin = "https://autograph.invalid";
  const parsed = new URL(url, internalOrigin);
  parsed.searchParams.set("passkey", "unavailable");

  return parsed.origin === internalOrigin
    ? `${parsed.pathname}${parsed.search}${parsed.hash}`
    : parsed.toString();
}
