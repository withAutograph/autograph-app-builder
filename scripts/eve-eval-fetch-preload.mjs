/**
 * Eve 0.44.x reuses one evaluation AbortSignal for every HTTP request in a
 * multi-turn session. Undici installs a listener on that signal per request,
 * so longer evaluations emit MaxListenersExceededWarning even though each
 * request has completed. Give every request a derived signal with identical
 * cancellation semantics and a request-scoped listener boundary.
 *
 * This intentionally does not change EventTarget limits or suppress process
 * warnings. Remove it when Eve no longer retains listeners on the shared
 * evaluation signal.
 */
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function isolateAbortSignalPerFetch(fetchImplementation) {
  return function fetchWithIsolatedSignal(input, init) {
    if (init?.signal === undefined || init.signal === null)
      return Reflect.apply(fetchImplementation, this, [input, init]);
    return Reflect.apply(fetchImplementation, this, [
      input,
      { ...init, signal: AbortSignal.any([init.signal]) },
    ]);
  };
}

if (process.env.APP_BUILDER_EVE_EVAL_FETCH_PRELOAD === "1") {
  if (typeof globalThis.fetch !== "function")
    throw new Error("The Eve eval fetch implementation was unavailable.");
  globalThis.fetch = isolateAbortSignalPerFetch(globalThis.fetch);
  delete process.env.APP_BUILDER_EVE_EVAL_FETCH_PRELOAD;
}
