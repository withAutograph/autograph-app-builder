import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { readdirSync } from "node:fs";
import { expect, it } from "vitest";
import {
  digestProcessStdout,
  digestProcessStdoutSync,
  processStdoutByteStream,
  streamProcessRecords,
} from "./captured-process-output";

it("digests command output above the former capture threshold without retaining it", () => {
  const before = new Set(
    readdirSync(tmpdir()).filter((name) => name.startsWith("app-builder-command-digest-")),
  );
  const bytes = Buffer.alloc(12 * 1024 * 1024, 97);
  const expected = createHash("sha256").update(bytes).digest("hex");
  expect(
    digestProcessStdoutSync(process.execPath, [
      "-e",
      `process.stdout.write(Buffer.alloc(${bytes.length}, 97))`,
    ]),
  ).toBe(expected);
  const after = readdirSync(tmpdir()).filter((name) =>
    name.startsWith("app-builder-command-digest-"),
  );
  expect(after.filter((name) => !before.has(name))).toEqual([]);
});

it("streams delimited records across output chunks without retaining the full result", async () => {
  let count = 0;
  for await (const record of streamProcessRecords(
    process.execPath,
    ["-e", "for (let i = 0; i < 120000; i++) process.stdout.write('record-' + i + '\\0')"],
    0,
  )) {
    expect(record).toBe(`record-${count}`);
    count += 1;
  }
  expect(count).toBe(120_000);
});

it("rejects an incomplete NUL record after preserving Unicode boundaries", async () => {
  const records: string[] = [];
  await expect(
    (async () => {
      for await (const record of streamProcessRecords(
        process.execPath,
        ["-e", "process.stdout.write('☃\\0'); process.stdout.write('incomplete')"],
        0,
      )) {
        records.push(record);
      }
    })(),
  ).rejects.toThrow(/incomplete NUL-delimited record/u);
  expect(records).toEqual(["☃"]);
});

it("streams large command output to a consumer and computes its digest", async () => {
  const size = 12 * 1024 * 1024;
  const command = ["-e", `process.stdout.write(Buffer.alloc(${size}, 97))`];
  const expected = createHash("sha256").update(Buffer.alloc(size, 97)).digest("hex");
  expect(await digestProcessStdout(process.execPath, command)).toBe(expected);

  const stream = processStdoutByteStream(process.execPath, command);
  const reader = stream.getReader();
  const hash = createHash("sha256");
  let received = 0;
  for (;;) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- The reader must consume one chunk at a time.
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    received += value.byteLength;
    hash.update(value);
  }
  expect(received).toBe(size);
  expect(hash.digest("hex")).toBe(expected);
});

it("rejects failed commands after streaming their output", async () => {
  const reader = processStdoutByteStream(process.execPath, [
    "-e",
    "process.stdout.write('partial'); process.exit(7)",
  ]).getReader();
  await expect(
    (async () => {
      for (;;) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- The process failure surfaces during stream consumption.
        const result = await reader.read();
        if (result.done) {
          return;
        }
      }
    })(),
  ).rejects.toThrow(/exited with status 7/u);
});
