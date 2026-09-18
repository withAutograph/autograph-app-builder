import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";

it("preserves a readable runtime stream when another mapped stream is missing", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "owner-stream-partial-"));
  try {
    const store = path.join(root, "store");
    const runs = path.join(store, "streams/runs");
    const chunks = path.join(store, "streams/chunks/strm_present");
    mkdirSync(runs, { recursive: true });
    mkdirSync(chunks, { recursive: true });
    writeFileSync(
      path.join(runs, "wrun_fixture.json"),
      JSON.stringify({ streams: ["strm_present", "strm_missing"] }),
    );
    const event = {
      data: {
        result: {
          callId: "call-one",
          kind: "tool-result",
          output: { status: "validated" },
          toolName: "validate_app_creation",
        },
        sequence: 1,
        status: "completed",
        stepIndex: 1,
        turnId: "turn-one",
      },
      type: "action.result",
    };
    const encoded = Buffer.from(
      `devl${JSON.stringify([["Uint8Array", 1], Buffer.from(JSON.stringify(event)).toString("base64")])}`,
    );
    const frame = Buffer.alloc(5 + encoded.length);
    frame.writeUInt32BE(encoded.length, 1);
    encoded.copy(frame, 5);
    writeFileSync(path.join(chunks, "chnk_one.bin"), frame);
    const output = path.join(root, "output");
    execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        path.join(import.meta.dirname, "observe-source-review-events.mts"),
        "--owner-store",
        store,
        "--run-id",
        "wrun_fixture",
        "--output-dir",
        output,
      ],
      { stdio: "pipe" },
    );
    const report = z
      .object({
        coverage: z.object({ readableEvents: z.number(), unreadable: z.number() }),
        rows: z.array(z.object({ status: z.string(), tool: z.string() })),
      })
      .parse(JSON.parse(readFileSync(path.join(output, "report.json"), "utf-8")));
    expect(report.coverage).toMatchObject({ readableEvents: 1, unreadable: 1 });
    expect(report.rows).toEqual([
      expect.objectContaining({ status: "validated", tool: "validate_app_creation" }),
    ]);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

it.each(["dot-prefixed", "symlink"])(
  "rejects %s output inside the owner store before writing",
  (kind) => {
    const root = mkdtempSync(path.join(os.tmpdir(), "owner-output-boundary-"));
    try {
      const store = path.join(root, "store");
      mkdirSync(store);
      const link = path.join(root, "external-link");
      symlinkSync(store, link);
      const output = path.join(kind === "symlink" ? link : store, "..evidence");
      expect(() =>
        execFileSync(
          process.execPath,
          [
            "--import",
            "tsx",
            path.join(import.meta.dirname, "observe-source-review-events.mts"),
            "--owner-store",
            store,
            "--run-id",
            "wrun_fixture",
            "--output-dir",
            output,
          ],
          { stdio: "pipe" },
        ),
      ).toThrow("Output must be external");
      expect(existsSync(output)).toBe(false);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  },
);
