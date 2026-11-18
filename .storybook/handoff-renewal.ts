// Storybook never renews a real handoff.
export async function renewBuilderHandoff() {
  return { status: "error" as const };
}
