import { copyFile, mkdir, readFile, readdir, writeFile as writeRawFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { renderReport } from "./report";
import { captureFilename } from "./archive-path";
import { readArchivedReport } from "./archive-entry";
import { formatWithOxfmt } from "../format-with-oxfmt.mts";

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
async function writeFile(path: string, content: string) {
  await writeRawFile(path, await formatWithOxfmt(path, content));
}

const { values } = parseArgs({
  options: {
    "report-dir": { type: "string" },
    name: { type: "string" },
    help: { type: "boolean" },
  },
});
if (values.help) {
  console.log("mise run eval:design-archive -- --report-dir PATH --name stock-exceptions");
  process.exit(0);
}
if (!values["report-dir"] || !values.name || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(values.name))
  throw new Error("Supply --report-dir and a lowercase kebab-case --name");
const input = resolve(values["report-dir"]);
const report = JSON.parse(await readFile(join(input, "report.json"), "utf-8"));
const timestamp = new Date(report.createdAt).toISOString();
const date = timestamp.slice(0, 10);
const time = timestamp.slice(11, 23).replaceAll(/[:.]/gu, "");
const archiveRoot = resolve("docs/reports/design-quality");
const relative = `${date}/${values.name}-${time}Z`;
const destination = join(archiveRoot, relative);
await mkdir(join(archiveRoot, date), { recursive: true });
// A report is a historical observation: never silently replace an existing run.
await mkdir(destination);
for (const capture of report.captures) {
  const filename = captureFilename(capture.name);
  // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
  await copyFile(join(input, filename), join(destination, filename));
  capture.path = filename;
}
report.archive = {
  name: values.name,
  evaluatedAt: timestamp,
  archivedAt: new Date().toISOString(),
  note: "Saved generated preview; advisory model judgment, not human-calibrated ground truth. Local machine paths omitted.",
};
await writeFile(join(destination, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
await writeFile(join(destination, "index.html"), renderReport(report));
const md = (v: unknown) =>
  String(v).replaceAll(/[<>|]/gu, (c) => ({ "<": "&lt;", ">": "&gt;", "|": "\\|" })[c]!);
const lines = [
  `# ${values.name} — ${timestamp}`,
  "",
  "[All reports](../../README.md) · [Interactive HTML report](index.html) · [Full measurements and scoring](report.json)",
  "",
  "GitHub renders this summary and the screenshots. Download or clone this folder to open the HTML report locally; GitHub does not serve it as a website.",
  "",
  `**Subjective design score:** ${report.judge.subjectiveScore === undefined ? "Not available" : `${report.judge.subjectiveScore}/100`}. Model: ${report.judge.model ?? "not run"}. Rubric: ${report.judge.rubricVersion ?? "not run"}.`,
  "",
  "This report evaluates the captured preview; evaluation itself does not regenerate the app or prove a built backend. Scores are advisory and not human-calibrated.",
  "",
  "## Ratings",
  "",
  "| Dimension | Score | Reason |",
  "| --- | --- | --- |",
];
if (report.adherence) {
  const a = report.adherence;
  lines.splice(
    8,
    0,
    `**Arrusted adherence:** ${a.score ?? "unassessed"}/100 (${a.status}); evidence coverage ${a.coveragePercent ?? "unassessed"}%. Evaluator ${a.version}.`,
    "",
    "| Dimension | Conforming | Nonconforming | Unassessed | Adherence |",
    "| --- | --- | --- | --- | --- |",
    ...Object.entries(a.dimensions).map(([name, value]) => {
      const d = value as {
        conforming: number;
        nonconforming: number;
        unassessed: number;
        assessed: number;
        percent: number | null;
      };
      return `| ${name} | ${d.conforming} | ${d.nonconforming} | ${d.unassessed} | ${d.percent === null ? "n/a" : `${Math.round(d.percent)}%`} (${d.conforming}/${d.assessed}) |`;
    }),
    "",
    "Scores from different evaluator versions or captured states are not directly comparable.",
    "",
  );
}
for (const [axis, rating] of Object.entries(report.judge.ratings ?? {})) {
  const r = rating as { score: number; reason: string };
  lines.push(`| ${md(axis)} | ${r.score}/4 | ${md(r.reason)} |`);
}
lines.push("", "## Strengths", "");
for (const strength of report.judge.strengths ?? []) lines.push(`- ${md(strength)}`);
lines.push("", "## Improvements", "");
for (const finding of report.judge.findings ?? [])
  lines.push(
    `- **${md(finding.severity)} — ${md(finding.image)}:** ${md(finding.explanation)} ${md(finding.improvement)}`,
  );
lines.push(
  "",
  "## Token evidence",
  "",
  "Percentages cover only assessed properties. Missing provenance and ambiguous CSS remain unassessed; matching literals are not proof of token usage.",
  "",
  "| Viewport | Category | Token references / assessed | Coverage |",
  "| --- | --- | --- | --- |",
);
for (const capture of report.captures)
  for (const [category, summary] of Object.entries(capture.styles?.categories ?? {})) {
    const s = summary as {
      counts: Record<string, number>;
      assessed: number;
      total: number;
      coveragePercent: number | null;
    };
    lines.push(
      `| ${md(capture.name)} | ${md(category)} | ${capture.styles.observations?.filter((o: { category: string; provenance: string; classification: string }) => o.category === category && o.provenance === "generated" && o.classification === "semantic-token-reference").length ?? s.counts["token-reference"] ?? 0}/${s.assessed} | ${s.coveragePercent ?? "n/a"}% (${s.assessed}/${s.total}) |`,
    );
  }
lines.push("", "## Latest-run screenshots", "");
for (const capture of report.captures)
  lines.push(
    `### ${md(capture.name)} — ${md(capture.state)}`,
    "",
    `Interaction: ${md(capture.interaction.status)}.`,
    "",
    `![${md(capture.name)} ${md(capture.state)}](${capture.path})`,
    "",
  );
lines.push("## Limitations", "");
for (const limitation of report.judge.limitations ?? []) lines.push(`- ${md(limitation)}`);
for (const limitation of report.evaluationNotes ?? []) lines.push(`- ${md(limitation)}`);
await writeFile(join(destination, "README.md"), `${lines.join("\n")}\n`);
const rows: {
  path: string;
  name: string;
  date: string;
  score: unknown;
}[] = [];
for (const day of await readdir(archiveRoot, { withFileTypes: true })) {
  if (!day.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/u.test(day.name)) continue;
  // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
  for (const run of await readdir(join(archiveRoot, day.name), {
    withFileTypes: true,
  })) {
    if (!run.isDirectory()) continue;
    // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
    const saved = await readArchivedReport(join(archiveRoot, day.name, run.name));
    if (saved === null) continue;
    rows.push({
      path: `${day.name}/${run.name}`,
      name: saved.archive.name,
      date: saved.createdAt,
      score: saved.judge.subjectiveScore ?? "not scored",
    });
  }
}
rows.sort((a, b) => b.date.localeCompare(a.date));
await writeFile(
  join(archiveRoot, "README.md"),
  [
    "# Generated UI design reports",
    "",
    "Shared, advisory observations of generated previews. No pass threshold or runtime gate.",
    "",
    `**Latest report:** [${rows[0]!.name}](${rows[0]!.path}/README.md)`,
    "",
    "## Convention",
    "",
    "Each run lives in `YYYY-MM-DD/<app-name>-HHmmssSSSZ/`, using the evaluation timestamp in UTC. Keep earlier runs intact. Each folder contains a GitHub-readable `README.md`, `index.html`, `report.json`, and the matching screenshots. Screenshot names use `<viewport>-<state-index>.png`: state 0 is the initial screen; the report names subsequent interaction states. Do not replace one app's screenshots with another app's output.",
    "",
    "Generate into ignored `.artifacts/`, review for secrets/customer information, then explicitly archive:",
    "",
    "```sh",
    "mise run eval:design-archive -- --report-dir .artifacts/design-quality/RUN --name app-name",
    "```",
    "",
    "Archiving copies saved evidence; it does not rerun the evaluator, stage Git changes, push, or deploy. Commit the complete folder and this index together. Existing PNG baselines were retired; screenshots here are evidence, not pixel-match expectations.",
    "",
    "## History",
    "",
    "| Evaluated (UTC) | App | Subjective score / 100 |",
    "| --- | --- | --- |",
    ...rows.map((r) => `| ${r.date} | [${r.name}](${r.path}/README.md) | ${r.score} |`),
    "",
  ].join("\n"),
);
console.log(`Archived report: ${destination}`);
