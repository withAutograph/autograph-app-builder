import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { judgeDesign } from "./judge";
import { renderReport } from "./report";

// Explicit retry of only the judge after credentials become available; no
// repeated browser capture, regeneration, dependency preparation or Sandbox.
const directory = path.resolve(process.argv[2] ?? "");
const brief = await readFile(process.argv[3], "utf-8");
const report = JSON.parse(await readFile(path.join(directory, "report.json"), "utf-8"));
// oxlint-disable-next-line typescript/no-unsafe-member-access -- Preserve the existing parsed JSON boundary.
report.judge = await judgeDesign({
  brief,
  // oxlint-disable-next-line typescript/no-unsafe-member-access, typescript/no-unsafe-call -- Rescore accepts the saved report as written by the capture process.
  evidence: report.captures.map(
    (c: { name: string; state: string; measurements: unknown; interaction: unknown }) => ({
      interaction: c.interaction,
      measurements: c.measurements,
      name: c.name,
      state: c.state,
    }),
  ),
  // oxlint-disable-next-line typescript/no-unsafe-member-access, typescript/no-unsafe-call -- Preserve the saved report handling and its existing failure behavior.
  images: report.captures.map((c: { name: string; width: number; height: number }) => ({
    ...c,
    path: path.join(directory, `${c.name}.png`),
  })),
});
await writeFile(path.join(directory, "report.json"), JSON.stringify(report, null, 2), {
  mode: 0o600,
});
// oxlint-disable-next-line typescript/no-unsafe-argument -- Preserve the existing report JSON passed to the renderer.
await writeFile(path.join(directory, "index.html"), renderReport(report), {
  mode: 0o600,
});
// oxlint-disable-next-line typescript/no-unsafe-member-access -- Preserve the existing parsed JSON boundary.
console.log(JSON.stringify(report.judge));
