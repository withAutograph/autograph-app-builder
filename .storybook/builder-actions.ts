/**
 * Server Actions are exercised through the deployed app and emulated E2E
 * suites. Storybook renders the client states only, so it must not bundle the
 * server-only provisioning and OAuth implementation.
 */
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function unavailable(): never {
  throw new Error("Builder server actions are unavailable in Storybook.");
}

// eslint-disable-next-line eslint/func-style, eslint/require-await -- Preserve function declaration hoisting and initialization timing.
export async function provisionBuilderProvider(): Promise<never> {
  return unavailable();
}

// eslint-disable-next-line eslint/func-style, eslint/require-await -- Preserve function declaration hoisting and initialization timing.
export async function reserveBuilderProvider(): Promise<never> {
  return unavailable();
}

// eslint-disable-next-line eslint/func-style, eslint/require-await -- Preserve function declaration hoisting and initialization timing.
export async function createBuilderHandoff(): Promise<never> {
  return unavailable();
}

// eslint-disable-next-line eslint/func-style, eslint/require-await -- Preserve function declaration hoisting and initialization timing.
export async function continueBuilderHandoff(): Promise<never> {
  return unavailable();
}
