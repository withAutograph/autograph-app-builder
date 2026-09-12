/**
 * The builder draft actions are server-only. Stories exercise client states,
 * so keep the database deployment modules out of the browser bundle.
 */
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function unavailable(): never {
  throw new Error("Builder draft actions are unavailable in Storybook.");
}

// eslint-disable-next-line eslint/func-style, eslint/require-await -- Preserve function declaration hoisting and initialization timing.
export async function saveActiveBuilderDraft(): Promise<never> {
  return unavailable();
}

// eslint-disable-next-line eslint/func-style, eslint/require-await -- Preserve function declaration hoisting and initialization timing.
export async function loadActiveBuilderDraft(): Promise<never> {
  return unavailable();
}
