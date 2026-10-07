const RENEWAL_INTERVAL_MS = 15_000;
const RENEWAL_MARGIN_MS = 60_000;
const LEASE_EXTENSION_MS = 300_000;

export interface ActiveCommandLeaseTarget {
  readonly expiresAt: Date | undefined;
  extendTimeout: (duration: number, options?: { signal?: AbortSignal }) => Promise<void>;
}

/** Renew only an owned command's running compute; idle sessions have no heartbeat. */
export const holdActiveCommandLease = async (input: {
  current: () => ActiveCommandLeaseTarget;
  authorize?: () => Promise<void>;
  signal?: AbortSignal;
}) => {
  const stopped = new AbortController();
  const failed = new AbortController();
  const signal = input.signal ? AbortSignal.any([input.signal, failed.signal]) : failed.signal;
  let pending: Promise<void> | null = null;
  const renew = async () => {
    const target = input.current();
    const expiry = target.expiresAt;
    if (expiry === undefined || expiry.getTime() - Date.now() > RENEWAL_MARGIN_MS) {
      return;
    }
    await input.authorize?.();
    const requestSignal = AbortSignal.any([signal, stopped.signal, AbortSignal.timeout(10_000)]);
    await target.extendTimeout(LEASE_EXTENSION_MS, { signal: requestSignal });
  };
  signal.throwIfAborted();
  await renew();
  signal.throwIfAborted();
  const timer = setInterval(() => {
    if (pending !== null || signal.aborted || stopped.signal.aborted) {
      return;
    }
    pending = (async () => {
      try {
        await renew();
      } catch (error) {
        if (!stopped.signal.aborted) {
          failed.abort(error);
        }
      } finally {
        pending = null;
      }
    })();
  }, RENEWAL_INTERVAL_MS);
  timer.unref();
  const stop = () => {
    clearInterval(timer);
    stopped.abort();
  };
  signal.addEventListener("abort", stop, { once: true });
  return {
    async finish() {
      signal.removeEventListener("abort", stop);
      stop();
      await pending;
    },
    signal,
  };
};
