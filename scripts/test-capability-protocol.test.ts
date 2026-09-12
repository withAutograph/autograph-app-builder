import { PassThrough, Writable } from "node:stream";

import { describe, expect, it } from "vitest";

import { relayBoundedFrames } from "./test-capability-protocol.mts";

describe("non-authorizing structural test protocol relay", () => {
  it("relays exact fragmented frames and honors backpressure", async () => {
    const source = new PassThrough();
    let output = "";
    let writes = 0;
    // Writable's implementation contract is callback-based.
    // oxlint-disable promise/prefer-await-to-callbacks
    const target = new Writable({
      highWaterMark: 1,
      write(chunk, _encoding, callback) {
        writes += 1;
        setTimeout(() => {
          output += chunk.toString("utf-8");
          callback();
        }, 2);
      },
    });
    // oxlint-enable promise/prefer-await-to-callbacks
    const relay = relayBoundedFrames({ source, target, expectedFrames: 2 });
    source.write('{"version":');
    source.write("2}\n");
    source.end('{"nonce":"abc"}\n');
    await relay;
    expect(output).toBe('{"version":2}\n{"nonce":"abc"}\n');
    expect(writes).toBe(2);
  });

  it("rejects oversized, trailing, and incomplete frames", async () => {
    for (const sourceText of ["x".repeat(4097), "{}\n{}\n", "{}"] as const) {
      const source = new PassThrough();
      const target = new PassThrough();
      const relay = relayBoundedFrames({ source, target, expectedFrames: 1 });
      source.end(sourceText);
      // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
      await expect(relay).rejects.toThrow(/Protocol/u);
    }
  });
});
