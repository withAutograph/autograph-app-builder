import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { expect, it } from "vitest";

import { streamingMaterializeAdapter } from "./node-fresh-bootstrap";

it("materializes large binary and Unicode paths with exact Git blob identity", () => {
  const stage = mkdtempSync(nodePath.join(tmpdir(), "bootstrap-materialize-test-"));
  const stageFd = openSync(stage, "r");
  const path = "nested/snowman-☃.bin";
  const bytes = Buffer.alloc(4 * 1024 * 1024, 0xa5);
  bytes.set(Buffer.from("☃\0binary", "utf-8"), 1024);
  // oxlint-disable-next-line sonarjs/hashing -- Git blob identity is defined by SHA-1 in this bootstrap format.
  const blob = createHash("sha1")
    .update(Buffer.from(`blob ${bytes.byteLength}\0`))
    .update(bytes)
    .digest("hex");
  try {
    const run = (input: Buffer, recovery: boolean) =>
      spawnSync(
        "/usr/bin/python3",
        [
          "-I",
          "-c",
          streamingMaterializeAdapter,
          path,
          "100644",
          blob,
          String(bytes.byteLength),
          recovery ? "1" : "0",
        ],
        { input, stdio: ["pipe", "pipe", "pipe", stageFd] },
      );
    const created = run(bytes, false);
    expect(created.status, created.stderr.toString()).toBe(0);
    expect(readFileSync(nodePath.join(stage, path))).toEqual(bytes);
    const recovered = run(bytes, true);
    expect(recovered.status, recovered.stderr.toString()).toBe(0);
    const invalid = run(bytes.subarray(0, -1), false);
    expect(invalid.status).not.toBe(0);
    expect(readFileSync(nodePath.join(stage, path))).toEqual(bytes);
  } finally {
    closeSync(stageFd);
    rmSync(stage, { force: true, recursive: true });
  }
}, 30_000);
