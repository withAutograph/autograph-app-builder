export function createBoundedAuthorizationRefresh(input?: {
  maximumAttempts?: number;
  minimumIntervalMs?: number;
}) {
  const maximumAttempts = input?.maximumAttempts ?? 3;
  const minimumIntervalMs = input?.minimumIntervalMs ?? 1000;
  let state = { attempts: 0, key: "", lastAt: 0 };

  return {
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
    reset(key: string) {
      state = { key, attempts: 0, lastAt: 0 };
    },
  };
}
