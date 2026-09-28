import { createHash } from "node:crypto";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { describe, expect, it } from "vitest";

import { digestProcessStdout } from "./captured-process-output";
import { hashBootstrapFile } from "./node-fresh-bootstrap";

describe("fresh bootstrap streamed Git blob hashing", () => {
  it("hashes large command output without returning its body", async () => {
    const chunk = Buffer.alloc(32 * 1024, 0x62);
    const expected = createHash("sha256");
    for (let index = 0; index < 512; index += 1) {
      expected.update(chunk);
    }
    const actual = await digestProcessStdout(process.execPath, [
      "-e",
      "const chunk = Buffer.alloc(32768, 0x62); for (let index = 0; index < 512; index += 1) process.stdout.write(chunk);",
    ]);
    expect(actual).toBe(expected.digest("hex"));
  });

  it("preserves SHA-1 Git object identity and SHA-256 content identity for a large file", async () => {
    const directory = await mkdtemp(nodePath.join(tmpdir(), "bootstrap-stream-test-"));
    const path = nodePath.join(directory, "large.bin");
    const chunk = Buffer.alloc(64 * 1024, 0xa5);
    const chunkCount = 256;
    const size = chunk.byteLength * chunkCount;
    const contentHash = createHash("sha256");
    // oxlint-disable-next-line sonarjs/hashing -- Git SHA-1 object identity is the exact repository format under test.
    const blobHash = createHash("sha1").update(`blob ${size}\0`);
    try {
      const file = await open(path, "w", 0o600);
      try {
        for (let index = 0; index < chunkCount; index += 1) {
          // oxlint-disable-next-line eslint/no-await-in-loop -- The test writes one bounded chunk at a time.
          await file.write(chunk);
          contentHash.update(chunk);
          blobHash.update(chunk);
        }
      } finally {
        await file.close();
      }
      expect(await hashBootstrapFile(path)).toBe(contentHash.digest("hex"));
      expect(await hashBootstrapFile(path, `blob ${size}\0`, "sha1")).toBe(blobHash.digest("hex"));
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
