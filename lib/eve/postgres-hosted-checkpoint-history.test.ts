import { describe, expect, it } from "vitest";

import { encodeCheckpointJson } from "./postgres-hosted-checkpoint-history";

describe("paged checkpoint encoding", () => {
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
