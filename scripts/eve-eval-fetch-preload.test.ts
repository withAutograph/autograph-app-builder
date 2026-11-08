import { describe, expect, it, vi } from "vitest";

import { isolateAbortSignalPerFetch } from "./eve-eval-fetch-preload.mjs";

describe("Eve eval fetch signal isolation", () => {
  it("derives one signal per request while retaining cancellation", async () => {
    const observedSignals: AbortSignal[] = [];
    // oxlint-disable-next-line typescript/promise-function-async -- Preserve the returned promise and synchronous throw behavior.
    const fetchImplementation = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.signal !== undefined && init.signal !== null) {
        observedSignals.push(init.signal);
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    });
    const fetch = isolateAbortSignalPerFetch(fetchImplementation);
    const evaluation = new AbortController();

    await Promise.all(
      // oxlint-disable-next-line typescript/promise-function-async -- Preserve the returned promise and synchronous throw behavior.
      Array.from({ length: 12 }, (_, index) =>
        fetch(`http://127.0.0.1/${index}`, { signal: evaluation.signal }),
      ),
    );

    expect(observedSignals).toHaveLength(12);
    expect(new Set(observedSignals)).toHaveLength(12);
    expect(observedSignals).not.toContain(evaluation.signal);
    expect(observedSignals.every((signal) => !signal.aborted)).toBe(true);

    const reason = new Error("evaluation interrupted");
    evaluation.abort(reason);
    expect(observedSignals.every((signal) => signal.aborted && signal.reason === reason)).toBe(
      true,
    );
  });

  it("leaves requests without an explicit signal unchanged", async () => {
    // oxlint-disable-next-line typescript/promise-function-async -- Preserve the returned promise and synchronous throw behavior.
    const fetchImplementation = vi.fn(() => Promise.resolve(new Response(null)));
    const fetch = isolateAbortSignalPerFetch(fetchImplementation);

    await fetch("http://127.0.0.1/");

    expect(fetchImplementation).toHaveBeenCalledWith("http://127.0.0.1/", undefined);
  });
});
