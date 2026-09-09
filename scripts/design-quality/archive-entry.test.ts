import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { readArchivedReport } from "./archive-entry";

it("ignores screenshot-only supplements but retains scored reports", async () => {
  const directory = await mkdtemp(join(tmpdir(), "design-supplement-"));
  await writeFile(join(directory, "desktop-0.png"), "fixture");
  expect(await readArchivedReport(directory)).toBeNull();
  await writeFile(join(directory, "report.json"), '{"score":75}');
  expect(await readArchivedReport(directory)).toEqual({ score: 75 });
});

it("does not hide malformed report data", async () => {
  const directory = await mkdtemp(join(tmpdir(), "design-malformed-"));
  await writeFile(join(directory, "report.json"), "not json");
  await expect(readArchivedReport(directory)).rejects.toThrow();
});
