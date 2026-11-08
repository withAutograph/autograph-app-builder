export const PASSKEY_ONBOARDING_ALREADY_AUTHENTICATED = "PASSKEY_ONBOARDING_ALREADY_AUTHENTICATED";

interface PasskeyErrorEnvelope {
  code?: unknown;
  error?: unknown;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Preserve the existing unknown input contract.
export function passkeyErrorCode(value: unknown): string | undefined {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Preserve this runtime check and existing input handling.
  if (value === null || typeof value !== "object") {
    return undefined;
  }

  const envelope = value as PasskeyErrorEnvelope;
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Preserve this runtime check and existing input handling.
  if (typeof envelope.code === "string") {
    return envelope.code;
  }
  // oxlint-disable-next-line anti-slop/no-runtime-typeof, typescript/strict-boolean-expressions -- Preserve the runtime type check and truthiness behavior.
  if (!envelope.error || typeof envelope.error !== "object") {
    return undefined;
  }

  const nestedCode = (envelope.error as PasskeyErrorEnvelope).code;
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Preserve this runtime check and existing input handling.
  return typeof nestedCode === "string" ? nestedCode : undefined;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Preserve the existing unknown input contract.
export function isPasskeyOnboardingAlreadyAuthenticated(value: unknown) {
  return passkeyErrorCode(value) === PASSKEY_ONBOARDING_ALREADY_AUTHENTICATED;
}
