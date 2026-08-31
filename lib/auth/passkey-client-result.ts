type PasskeyClientError = {
  code?: unknown;
  message?: unknown;
};

const USER_MEDIATED_NO_ASSERTION_CODE = "ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY";

export type PasskeyAuthenticationFailure = {
  assertionReturned: boolean;
  code?: string;
  error: Error;
  redirectToSignUp: boolean;
};

export function passkeyClientError(result: unknown): Error | null {
  if (!result || typeof result !== "object" || !("error" in result)) {
    return null;
  }

  const error = (result as { error?: PasskeyClientError | null }).error;
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
  const error = passkeyClientError(result);
  if (!error) return null;

  const assertionReturned =
    typeof result === "object" &&
    result !== null &&
    "webauthn" in result &&
    typeof result.webauthn === "object" &&
    result.webauthn !== null;
  const code = error.name === "Error" ? undefined : error.name;

  return {
    assertionReturned,
    ...(code ? { code } : {}),
    error,
    redirectToSignUp:
      !assertionReturned && code === USER_MEDIATED_NO_ASSERTION_CODE,
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
