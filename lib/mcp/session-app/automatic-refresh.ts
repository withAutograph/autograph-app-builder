// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function createBoundedAuthorizationRefresh(input?: { minimumIntervalMs?: number }) {
  const minimumIntervalMs = input?.minimumIntervalMs ?? 1000;
  let state = { key: "", lastAt: 0 };

  return {
    claim(key: string, now: number) {
      if (!key || key !== state.key || now - state.lastAt < minimumIntervalMs) {
        return false;
      }
      state.lastAt = now;
      return true;
    },
    reset(key: string) {
      state = { key, lastAt: 0 };
    },
  };
}
