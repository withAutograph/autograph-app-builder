/**
 * The builder draft actions are server-only. Stories exercise client states,
 * so keep the database deployment modules out of the browser bundle.
 */
function unavailable(): never {
  throw new Error("Builder draft actions are unavailable in Storybook.");
}

export async function saveActiveBuilderDraft(): Promise<never> {
  return unavailable();
}

export async function clearBuilderDraft(): Promise<never> {
  return unavailable();
}
