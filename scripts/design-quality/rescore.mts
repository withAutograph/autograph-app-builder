import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { judgeDesign } from "./judge";
import { renderReport } from "./report";
import { z } from "zod";

// Explicit retry of only the judge after credentials become available; no
// repeated browser capture, regeneration, dependency preparation or Sandbox.
const directory = path.resolve(process.argv[2] ?? "");
const brief = await readFile(process.argv[3], "utf-8");
type Report = Parameters<typeof renderReport>[0];
const reportSchema: z.ZodType<Report> = z.looseObject({
  captures: z.array(
    z.object({
      height: z.number().optional(),
      interaction: z.unknown(),
      measurements: z.unknown(),
      name: z.string(),
      state: z.string(),
      width: z.number().optional(),
    }),
  ),
  createdAt: z.string(),
  judge: z.record(z.string(), z.unknown()),
  source: z.record(z.string(), z.unknown()),
});
let report: Report;
try {
  report = reportSchema.parse(
    JSON.parse(await readFile(path.join(directory, "report.json"), "utf-8")),
  );
} catch {
  throw new TypeError("report.json has an invalid report shape");
}
report.judge = await judgeDesign({
  brief,
  evidence: report.captures.map(
    (c: { name: string; state: string; measurements: unknown; interaction: unknown }) => ({
      interaction: c.interaction,
      measurements: c.measurements,
      name: c.name,
      state: c.state,
    }),
  ),
  images: report.captures.map((c: { name: string; width: number; height: number }) => ({
    ...c,
    path: path.join(directory, `${c.name}.png`),
  })),
});
await writeFile(path.join(directory, "report.json"), JSON.stringify(report, null, 2), {
  mode: 0o600,
});
await writeFile(path.join(directory, "index.html"), renderReport(report), {
  mode: 0o600,
});
console.log(JSON.stringify(report.judge));
