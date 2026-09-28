import { createHash } from "node:crypto";

import { expect, it, vi } from "vitest";

import { sourceBytes } from "./node-fresh-bootstrap";
import type { FreshBootstrapSourceWorkspace } from "./node-fresh-bootstrap";

it("reads a large prepared source through provider chunks without the whole-file API", async () => {
  const chunk = Buffer.alloc(64 * 1024, 0xa5);
  chunk.set(Buffer.from("☃\0", "utf-8"), 37);
  const count = 192;
  const readSourceFile = vi.fn(async () => {
    await Promise.resolve();
    return Buffer.alloc(count * chunk.byteLength);
  });
  const readSourceFileStream = vi.fn(async () => {
    await Promise.resolve();
    return new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < count; index += 1) {
          controller.enqueue(chunk);
        }
        controller.close();
      },
    });
  });
  const workspace = {
    files: [],
    readSourceFile,
    readSourceFileStream,
    reverify: async () => {
      await Promise.resolve();
    },
  } satisfies FreshBootstrapSourceWorkspace;
  const hash = createHash("sha256");
  let size = 0;
  for await (const bytes of sourceBytes(workspace, "assets/large.bin")) {
    hash.update(bytes);
    size += bytes.byteLength;
  }
  const expected = createHash("sha256");
  for (let index = 0; index < count; index += 1) {
    expected.update(chunk);
  }
  expect(size).toBe(12 * 1024 * 1024);
  expect(hash.digest("hex")).toBe(expected.digest("hex"));
  expect(readSourceFileStream).toHaveBeenCalledWith("assets/large.bin");
  expect(readSourceFile).not.toHaveBeenCalled();
});
