/* oxlint-disable typescript/no-unsafe-member-access -- Preserve the existing untyped input and rendering boundary. */
import { copyFile, mkdir, readFile, readdir, writeFile as writeRawFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { renderReport } from "./report";
import { captureFilename } from "./archive-path";
import { readArchivedReport } from "./archive-entry";
import { formatWithOxfmt } from "../format-with-oxfmt.mts";

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
async function writeFile(filePath: string, content: string) {
  await writeRawFile(filePath, await formatWithOxfmt(filePath, content));
}

const { values } = parseArgs({
  options: {
    help: { type: "boolean" },
    name: { type: "string" },
    "report-dir": { type: "string" },
  },
});
if (values.help === true) {
  console.log("mise run eval:design-archive -- --report-dir PATH --name stock-exceptions");
  process.exit(0);
}
if (values["report-dir"] === undefined || values["report-dir"] === "") {
  throw new Error("Supply --report-dir and a lowercase kebab-case --name");
}
if (
  values.name === undefined ||
  values.name === "" ||
  !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(values.name)
) {
  throw new Error("Supply --report-dir and a lowercase kebab-case --name");
}
const input = path.resolve(values["report-dir"]);
// oxlint-disable-next-line typescript/no-unsafe-assignment -- Preserve the existing JSON parsing boundary.
const report = JSON.parse(await readFile(path.join(input, "report.json"), "utf-8"));
// oxlint-disable-next-line typescript/no-unsafe-argument -- Preserve the existing archived report JSON boundary.
const timestamp = new Date(report.createdAt).toISOString();
const date = timestamp.slice(0, 10);
const time = timestamp.slice(11, 23).replaceAll(/[:.]/gu, "");
const archiveRoot = path.resolve("docs/reports/design-quality");
const relative = `${date}/${values.name}-${time}Z`;
const destination = path.join(archiveRoot, relative);
await mkdir(path.join(archiveRoot, date), { recursive: true });
// A report is a historical observation: never silently replace an existing run.
await mkdir(destination);
for (const capture of report.captures) {
  // oxlint-disable-next-line typescript/no-unsafe-argument -- Preserve the existing archived report JSON boundary.
  const filename = captureFilename(capture.name);
  // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
  await copyFile(path.join(input, filename), path.join(destination, filename));
  capture.path = filename;
}
report.archive = {
  archivedAt: new Date().toISOString(),
  evaluatedAt: timestamp,
  name: values.name,
  note: "Saved generated preview; advisory model judgment, not human-calibrated ground truth. Local machine paths omitted.",
};
await writeFile(path.join(destination, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
// oxlint-disable-next-line typescript/no-unsafe-argument -- Preserve the existing archived report JSON boundary.
await writeFile(path.join(destination, "index.html"), renderReport(report));
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Preserve the existing unknown input contract.
const md = (v: unknown) =>
  String(v).replaceAll(/[<>|]/gu, (c) => ({ "<": "&lt;", ">": "&gt;", "|": "\\|" })[c] ?? c);
const lines = [
  `# ${values.name} — ${timestamp}`,
  "",
  "[All reports](../../README.md) · [Interactive HTML report](index.html) · [Full measurements and scoring](report.json)",
  "",
  "GitHub renders this summary and the screenshots. Download or clone this folder to open the HTML report locally; GitHub does not serve it as a website.",
  "",
];
const subjectiveScore =
  report.judge.subjectiveScore === undefined
    ? "Not available"
    : `${report.judge.subjectiveScore}/100`;
lines.push(
  `**Subjective design score:** ${subjectiveScore}. Model: ${report.judge.model ?? "not run"}. Rubric: ${report.judge.rubricVersion ?? "not run"}.`,
  "",
  "This report evaluates the captured preview; evaluation itself does not regenerate the app or prove a built backend. Scores are advisory and not human-calibrated.",
  "",
  "## Ratings",
  "",
  "| Dimension | Score | Reason |",
  "| --- | --- | --- |",
);
/* oxlint-disable typescript/strict-boolean-expressions -- Preserve the existing truthiness for supported values. */
if (report.adherence) {
  // oxlint-disable-next-line typescript/no-unsafe-assignment -- Preserve the existing dynamic value boundary.
  const a = report.adherence;
  lines.splice(
    8,
    0,
    `**Arrusted adherence:** ${a.score ?? "unassessed"}/100 (${a.status}); evidence coverage ${a.coveragePercent ?? "unassessed"}%. Evaluator ${a.version}.`,
    "",
    "| Dimension | Conforming | Nonconforming | Unassessed | Adherence |",
    "| --- | --- | --- | --- | --- |",
    // oxlint-disable-next-line typescript/no-unsafe-argument -- Preserve the existing archived report JSON boundary.
    ...Object.entries(a.dimensions).map(([name, value]) => {
      // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion, typescript/no-unsafe-type-assertion -- Preserve the existing assertion at this boundary. Preserve the existing assertion and its runtime behavior.
      const d = value as {
        conforming: number;
        nonconforming: number;
        unassessed: number;
        assessed: number;
        percent: number | null;
      };
      const rowPrefix = `| ${name} | ${d.conforming} | ${d.nonconforming} | ${d.unassessed} | `;
      const percent = d.percent === null ? "n/a" : `${Math.round(d.percent)}%`;
      return `${rowPrefix}${percent} (${d.conforming}/${d.assessed}) |`;
    }),
    "",
    "Scores from different evaluator versions or captured states are not directly comparable.",
    "",
  );
}
/* oxlint-enable typescript/strict-boolean-expressions */
// oxlint-disable-next-line typescript/no-unsafe-argument -- Preserve the existing archived report JSON boundary.
for (const [axis, rating] of Object.entries(report.judge.ratings ?? {})) {
  // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion, typescript/no-unsafe-type-assertion -- Preserve the existing assertion at this boundary. Preserve the existing assertion and its runtime behavior.
  const r = rating as { score: number; reason: string };
  lines.push(`| ${md(axis)} | ${r.score}/4 | ${md(r.reason)} |`);
}
lines.push("", "## Strengths", "");
for (const strength of report.judge.strengths ?? []) {
  lines.push(`- ${md(strength)}`);
}
lines.push("", "## Improvements", "");
for (const finding of report.judge.findings ?? []) {
  lines.push(
    `- **${md(finding.severity)} — ${md(finding.image)}:** ${md(finding.explanation)} ${md(finding.improvement)}`,
  );
}
lines.push(
  "",
  "## Token evidence",
  "",
  "Percentages cover only assessed properties. Missing provenance and ambiguous CSS remain unassessed; matching literals are not proof of token usage.",
  "",
  "| Viewport | Category | Token references / assessed | Coverage |",
  "| --- | --- | --- | --- |",
);
for (const capture of report.captures) {
  // oxlint-disable-next-line typescript/no-unsafe-argument -- Preserve the existing archived report JSON boundary.
  for (const [category, summary] of Object.entries(capture.styles?.categories ?? {})) {
    // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion, typescript/no-unsafe-type-assertion -- Preserve the existing assertion at this boundary. Preserve the existing assertion and its runtime behavior.
    const s = summary as {
      counts: Record<string, number>;
      assessed: number;
      total: number;
      coveragePercent: number | null;
    };
    lines.push(
      // oxlint-disable-next-line typescript/no-unsafe-call -- Archive reads observations from the saved report without changing malformed-report behavior.
      `| ${md(capture.name)} | ${md(category)} | ${capture.styles.observations?.filter((o: { category: string; provenance: string; classification: string }) => o.category === category && o.provenance === "generated" && o.classification === "semantic-token-reference").length ?? s.counts["token-reference"] ?? 0}/${s.assessed} | ${s.coveragePercent ?? "n/a"}% (${s.assessed}/${s.total}) |`,
    );
  }
}
lines.push("", "## Latest-run screenshots", "");
for (const capture of report.captures) {
  lines.push(
    `### ${md(capture.name)} — ${md(capture.state)}`,
    "",
    `Interaction: ${md(capture.interaction.status)}.`,
    "",
    `![${md(capture.name)} ${md(capture.state)}](${capture.path})`,
    "",
  );
}
lines.push("## Limitations", "");
for (const limitation of report.judge.limitations ?? []) {
  lines.push(`- ${md(limitation)}`);
}
for (const limitation of report.evaluationNotes ?? []) {
  lines.push(`- ${md(limitation)}`);
}
await writeFile(path.join(destination, "README.md"), `${lines.join("\n")}\n`);
const rows: {
  path: string;
  name: string;
  date: string;
  score: unknown;
}[] = [];
for (const day of await readdir(archiveRoot, { withFileTypes: true })) {
  if (!day.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/u.test(day.name)) {
    continue;
  }
  // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
  for (const run of await readdir(path.join(archiveRoot, day.name), {
    withFileTypes: true,
  })) {
    if (!run.isDirectory()) {
      continue;
    }
    // oxlint-disable-next-line eslint/no-await-in-loop, typescript/no-unsafe-assignment -- preserve intentional sequential control flow; Preserve the existing dynamic value boundary.
    const saved = await readArchivedReport(path.join(archiveRoot, day.name, run.name));
    if (saved !== null) {
      rows.push({
        // oxlint-disable-next-line typescript/no-unsafe-assignment -- Preserve the existing dynamic value boundary.
        date: saved.createdAt,
        // oxlint-disable-next-line typescript/no-unsafe-assignment -- Preserve the existing dynamic value boundary.
        name: saved.archive.name,
        path: `${day.name}/${run.name}`,
        score: saved.judge.subjectiveScore ?? "not scored",
      });
    }
  }
}
rows.sort((a, b) => b.date.localeCompare(a.date));
const latest = rows.at(0);
if (latest === undefined) {
  throw new Error("Archived report index is unexpectedly empty");
}
await writeFile(
  path.join(archiveRoot, "README.md"),
  [
    "# Generated UI design reports",
    "",
    "Shared, advisory observations of generated previews. No pass threshold or runtime gate.",
    "",
    `**Latest report:** [${latest.name}](${latest.path}/README.md)`,
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
    ...rows.map((r) => `| ${r.date} | [${r.name}](${r.path}/README.md) | ${String(r.score)} |`),
    "",
  ].join("\n"),
);
console.log(`Archived report: ${destination}`);
