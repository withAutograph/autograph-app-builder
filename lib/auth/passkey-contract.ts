export const PASSKEY_ONBOARDING_ALREADY_AUTHENTICATED = "PASSKEY_ONBOARDING_ALREADY_AUTHENTICATED";

interface PasskeyErrorEnvelope {
  code?: unknown;
  error?: unknown;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function passkeyErrorCode(value: unknown): string | undefined {
  if (value === null || typeof value !== "object") {
    return undefined;
  }

  const envelope: PasskeyErrorEnvelope = value;
  if (typeof envelope.code === "string") {
    return envelope.code;
  }
  if (envelope.error === null || typeof envelope.error !== "object") {
    return undefined;
  }

  const nestedEnvelope: PasskeyErrorEnvelope = envelope.error;
  const nestedCode = nestedEnvelope.code;
  return typeof nestedCode === "string" ? nestedCode : undefined;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function isPasskeyOnboardingAlreadyAuthenticated(value: unknown) {
  return passkeyErrorCode(value) === PASSKEY_ONBOARDING_ALREADY_AUTHENTICATED;
}
