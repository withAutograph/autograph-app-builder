import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { readdirSync } from "node:fs";
import { expect, it } from "vitest";
import { digestProcessStdoutSync } from "./captured-process-output";

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
