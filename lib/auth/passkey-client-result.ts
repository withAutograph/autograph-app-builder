interface PasskeyClientError {
  code?: unknown;
  message?: unknown;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function passkeyResultError(result: unknown): PasskeyClientError | null {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Preserve this runtime check and existing input handling.
  if (result === null || typeof result !== "object" || !("error" in result)) {
    return null;
  }

  const { error } = result;
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Preserve this runtime check and existing input handling.
  return error !== null && typeof error === "object" ? error : null;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function passkeyClientError(result: unknown): Error | null {
  const error = passkeyResultError(result);
  if (!error) {
    return null;
  }

  const message =
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Preserve this runtime check and existing input handling.
    typeof error.message === "string" && error.message
      ? error.message
      : "Passkey authentication could not be completed.";
  const clientError = new Error(message);
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Preserve this runtime check and existing input handling.
  if (typeof error.code === "string") {
    clientError.name = error.code;
  }
  return clientError;
}
