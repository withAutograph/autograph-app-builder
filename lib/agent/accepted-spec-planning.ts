/**
 * Continue from a successfully accepted design without asking the model to
 * choose the next internal operation. Planning is skipped only after the same
 * accepted design has already crossed the planning boundary.
 */
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export async function planAcceptedAppSpec<TPhase extends string>(input: {
  readonly phase: TPhase;
  readonly planComplete: boolean;
  readonly plan: () => Promise<void>;
}) {
  if (input.planComplete) return;
  await input.plan();
}
