type PasskeyClientError = {
  code?: unknown;
  message?: unknown;
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
