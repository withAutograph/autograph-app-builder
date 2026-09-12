// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function createBoundedAuthorizationRefresh(input?: {
  maximumAttempts?: number;
  minimumIntervalMs?: number;
}) {
  const maximumAttempts = input?.maximumAttempts ?? 3;
  const minimumIntervalMs = input?.minimumIntervalMs ?? 1000;
  let state = { key: "", attempts: 0, lastAt: 0 };

  return {
    reset(key: string) {
      state = { key, attempts: 0, lastAt: 0 };
    },
    claim(key: string, now: number) {
      if (
        !key ||
        key !== state.key ||
        state.attempts >= maximumAttempts ||
        now - state.lastAt < minimumIntervalMs
      )
        return false;
      state.attempts += 1;
      state.lastAt = now;
      return true;
    },
  };
}
