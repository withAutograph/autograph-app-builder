import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { deterministicGzip } from "./deterministic-gzip";

const sha256 = (value: Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

describe("deterministic gzip", () => {
  it("emits fixed bytes without host-zlib metadata", () => {
    const content = Buffer.from("Autograph App Builder hosted artifact\n");
    const first = deterministicGzip(content);
    const second = deterministicGzip(content);

    expect(first).toEqual(second);
    expect([...first.subarray(0, 10)]).toEqual([
      0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02, 0x03,
    ]);
    expect(sha256(first)).toBe(
      "e34b1124586db69a28bc332fc778f31940a31b0c03096757d4afffd538c63338",
    );
  });
});
