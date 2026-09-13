import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { readArchivedReport } from "./archive-entry";

it("ignores screenshot-only supplements but retains scored reports", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "design-supplement-"));
  await writeFile(path.join(directory, "desktop-0.png"), "fixture");
  expect(await readArchivedReport(directory)).toBeNull();
  await writeFile(path.join(directory, "report.json"), '{"score":75}');
  expect(await readArchivedReport(directory)).toEqual({ score: 75 });
});

it("does not hide malformed report data", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "design-malformed-"));
  await writeFile(path.join(directory, "report.json"), "not json");
  await expect(readArchivedReport(directory)).rejects.toThrow();
});
