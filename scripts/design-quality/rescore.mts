import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { judgeDesign } from "./judge";
import { renderReport } from "./report";

// Explicit retry of only the judge after credentials become available; no
// repeated browser capture, regeneration, dependency preparation or Sandbox.
const directory = path.resolve(process.argv[2] ?? "");
const brief = await readFile(process.argv[3], "utf-8");
const report = JSON.parse(await readFile(path.join(directory, "report.json"), "utf-8"));
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
