/**
 * Server Actions are exercised through the deployed app and emulated E2E
 * suites. Storybook renders the client states only, so it must not bundle the
 * server-only provisioning and OAuth implementation.
 */
function unavailable(): never {
  throw new Error("Builder server actions are unavailable in Storybook.");
}

// oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test callback
export async function provisionBuilderProvider(): Promise<never> {
  return unavailable();
}

// oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test callback
export async function reserveBuilderProvider(): Promise<never> {
  return unavailable();
}

// oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test callback
export async function createBuilderHandoff(): Promise<never> {
  return unavailable();
}

// oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test callback
export async function continueBuilderHandoff(): Promise<never> {
  return unavailable();
}
