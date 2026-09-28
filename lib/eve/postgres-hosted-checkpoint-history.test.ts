import { describe, expect, it } from "vitest";

import { encodeCheckpointJson } from "./postgres-hosted-checkpoint-history";

describe("paged checkpoint encoding", () => {
  it("encodes more than 100,000 event items without retaining encoded bodies", async () => {
    let itemCount = 0;
    let largestFragment = 0;
    for (let index = 0; index < 100_001; index += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each event is encoded and released before the next.
      for await (const fragment of encodeCheckpointJson({
        index,
        status: "working",
        type: "status",
      })) {
        largestFragment = Math.max(largestFragment, fragment.byteLength);
      }
      itemCount += 1;
    }
    expect(itemCount).toBe(100_001);
    expect(largestFragment).toBeLessThan(64 * 1024);
  });

  it("streams a large Unicode item into bounded fragments without changing JSON", async () => {
    const value = {
      description: "🧭\n\u0000\t".repeat(30_000),
      options: [{ id: "one", label: "A".repeat(100_000) }],
    };
    const fragments: Uint8Array[] = [];
    for await (const fragment of encodeCheckpointJson(value)) {
      expect(fragment.byteLength).toBeLessThan(64 * 1024);
      fragments.push(fragment);
    }
    expect(fragments.length).toBeGreaterThan(10);
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(fragments));
    expect(JSON.parse(decoded)).toEqual(value);
    expect(decoded).toBe(JSON.stringify(value));
  });
});
