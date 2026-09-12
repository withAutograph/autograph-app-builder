import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { judgeDesign } from "./judge";
import { renderReport } from "./report";

// Explicit retry of only the judge after credentials become available; no
// repeated browser capture, regeneration, dependency preparation or Sandbox.
const directory = resolve(process.argv[2] ?? "");
const brief = await readFile(process.argv[3], "utf-8");
const report = JSON.parse(await readFile(join(directory, "report.json"), "utf-8"));
report.judge = await judgeDesign({
  brief,
  evidence: report.captures.map(
    (c: { name: string; state: string; measurements: unknown; interaction: unknown }) => ({
      name: c.name,
      state: c.state,
      measurements: c.measurements,
      interaction: c.interaction,
    }),
  ),
  images: report.captures.map((c: { name: string; width: number; height: number }) => ({
    ...c,
    path: join(directory, `${c.name}.png`),
  })),
});
await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
await writeFile(join(directory, "index.html"), renderReport(report), {
  mode: 0o600,
});
console.log(JSON.stringify(report.judge));
