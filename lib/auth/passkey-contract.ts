export const PASSKEY_ONBOARDING_ALREADY_AUTHENTICATED = "PASSKEY_ONBOARDING_ALREADY_AUTHENTICATED";

interface PasskeyErrorEnvelope {
  code?: string;
  error?: PasskeyErrorEnvelope | null;
}

export type PasskeyErrorValue = PasskeyErrorEnvelope | Error | null | undefined;

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function passkeyErrorCode(value: PasskeyErrorValue): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }

  const envelope: PasskeyErrorEnvelope = value;
  if (envelope.code !== undefined) {
    return envelope.code;
  }
  if (envelope.error === null || envelope.error === undefined) {
    return undefined;
  }

  return envelope.error.code;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function isPasskeyOnboardingAlreadyAuthenticated(value: PasskeyErrorValue) {
  return passkeyErrorCode(value) === PASSKEY_ONBOARDING_ALREADY_AUTHENTICATED;
}
