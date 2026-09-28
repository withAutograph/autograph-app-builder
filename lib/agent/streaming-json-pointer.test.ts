import { describe, expect, it } from "vitest";
import { readJsonPointerString } from "./streaming-json-pointer";

const stream = (source: string, width = 65_536): ReadableStream<Uint8Array> => {
  const bytes = new TextEncoder().encode(source);
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.subarray(offset, offset + width));
      offset += width;
    },
  });
};

describe("streaming JSON readback", () => {
  it("finds a nested marker while discarding a large unrelated value", async () => {
    const source = JSON.stringify({ ignored: "x".repeat(12_000_000), records: [{ value: "μ" }] });
    expect(await readJsonPointerString(stream(source), "/records/0/value", "μ")).toBe(true);
  });

  it("honors escaped pointer keys and Unicode split across byte chunks", async () => {
    const source = JSON.stringify({ "a/b": { "~key": "🚀" } });
    expect(await readJsonPointerString(stream(source, 1), "/a~1b/~0key", "🚀")).toBe(true);
  });

  it("rejects malformed trailing content after the requested value", async () => {
    await expect(
      readJsonPointerString(stream('{"value":"ok"} garbage'), "/value", "ok"),
    ).rejects.toThrow("Unexpected data");
  });

  it("treats a repeated key according to its final value", async () => {
    expect(
      await readJsonPointerString(stream('{"value":"ok","value":"wrong"}'), "/value", "ok"),
    ).toBe(false);
  });

  it("rejects incomplete strings and invalid numbers", async () => {
    await expect(readJsonPointerString(stream('{"value":"ok'), "/value", "ok")).rejects.toThrow();
    await expect(
      readJsonPointerString(stream('{"value":"ok","n":01}'), "/value", "ok"),
    ).rejects.toThrow();
  });
});
