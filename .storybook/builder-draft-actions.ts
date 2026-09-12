/**
 * The builder draft actions are server-only. Stories exercise client states,
 * so keep the database deployment modules out of the browser bundle.
 */
function unavailable(): never {
  throw new Error("Builder draft actions are unavailable in Storybook.");
}

// oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test callback
export async function saveActiveBuilderDraft(): Promise<never> {
  return unavailable();
}

// oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test callback
export async function loadActiveBuilderDraft(): Promise<never> {
  return unavailable();
}
