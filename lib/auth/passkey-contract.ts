export const PASSKEY_ONBOARDING_ALREADY_AUTHENTICATED =
  "PASSKEY_ONBOARDING_ALREADY_AUTHENTICATED";

type PasskeyErrorEnvelope = {
  code?: unknown;
  error?: unknown;
};

export function passkeyErrorCode(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;

  const envelope = value as PasskeyErrorEnvelope;
  if (typeof envelope.code === "string") return envelope.code;
  if (!envelope.error || typeof envelope.error !== "object") return undefined;

  const nestedCode = (envelope.error as PasskeyErrorEnvelope).code;
  return typeof nestedCode === "string" ? nestedCode : undefined;
}

export function isPasskeyOnboardingAlreadyAuthenticated(value: unknown) {
  return passkeyErrorCode(value) === PASSKEY_ONBOARDING_ALREADY_AUTHENTICATED;
}
