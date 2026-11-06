import { copyFile, mkdir, readFile, readdir, writeFile as writeRawFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { renderReport } from "./report";
import { captureFilename } from "./archive-path";
import { formatWithOxfmt } from "../format-with-oxfmt.mts";
import { z } from "zod";
import type { Adherence } from "./evidence";

type Report = Omit<Parameters<typeof renderReport>[0], "captures" | "judge" | "adherence"> & {
  judge: Parameters<typeof renderReport>[0]["judge"] & {
    subjectiveScore?: number;
    model?: string;
    rubricVersion?: number;
    ratings?: Record<string, { score: number; reason: string }>;
    strengths?: string[];
    findings?: { severity: string; image: string; explanation: string; improvement: string }[];
    limitations?: string[];
  };
  adherence?: Adherence;
  archive?: { archivedAt: string; evaluatedAt: string; name: string; note: string };
  captures: (Omit<
    Parameters<typeof renderReport>[0]["captures"][number],
    "styles" | "interaction"
  > & {
    path?: string;
    styles?: JsonValue & {
      categories?: Record<string, StyleSummary>;
      observations?: { category: string; provenance: string; classification: string }[];
    };
    interaction: JsonValue & { status: string };
  })[];
};
type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue | undefined };
interface StyleSummary {
  counts: Record<string, number>;
  assessed: number;
  total: number;
  coveragePercent: number | null;
}
interface ArchiveIndexEntry {
  createdAt: string;
  archive: { name: string };
  judge: { subjectiveScore?: number };
}

const archivedIndexEntrySchema = z.object({
  archive: z.object({ name: z.string() }),
  createdAt: z.string(),
  judge: z.object({ subjectiveScore: z.number().optional() }),
});
const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema.optional()),
  ]),
);
const reportParser: z.ZodType<Report> = z.looseObject({
  adherence: z
    .object({
      coveragePercent: z.number().nullable(),
      dimensions: z.record(
        z.string(),
        z.object({
          assessed: z.number(),
          browserCount: z.number(),
          conforming: z.number(),
          coveragePercent: z.number().nullable(),
          nonconforming: z.number(),
          percent: z.number().nullable(),
          staticCount: z.number(),
          total: z.number(),
          unassessed: z.number(),
        }),
      ),
      limitations: z.array(z.string()),
      method: z.string(),
      observations: z.array(
        z.looseObject({
          category: z.string(),
          classification: z.string(),
          provenance: z.string(),
        }),
      ),
      score: z.number().nullable(),
      status: z.string(),
      version: z.number(),
    })
    .optional(),
  archive: z
    .object({
      archivedAt: z.string(),
      evaluatedAt: z.string(),
      name: z.string(),
      note: z.string(),
    })
    .optional(),
  captures: z.array(
    z.object({
      interaction: jsonValueSchema.and(z.object({ status: z.string() })),
      measurements: jsonValueSchema,
      name: z.string(),
      path: z.string().optional(),
      state: z.string(),
      styles: jsonValueSchema.optional(),
    }),
  ),
  case: z
    .object({
      evidence: z.array(z.object({ path: z.string(), repo: z.string(), status: z.string() })),
      id: z.string(),
      notes: z.string(),
      outcomes: z.array(z.string()),
      reviewQuestions: z.array(z.string()),
      title: z.string(),
    })
    .optional(),
  createdAt: z.string(),
  evaluationNotes: z.array(z.string()).optional(),
  judge: z.object({
    findings: z
      .array(
        z.object({
          explanation: z.string(),
          image: z.string(),
          improvement: z.string(),
          severity: z.string(),
        }),
      )
      .optional(),
    limitations: z.array(z.string()).optional(),
    model: z.string().optional(),
    ratings: z.record(z.string(), z.object({ reason: z.string(), score: z.number() })).optional(),
    reason: z.string().optional(),
    rubricVersion: z.number().optional(),
    status: z.string().optional(),
    strengths: z.array(z.string()).optional(),
    subjectiveScore: z.number().optional(),
  }),
  reference: jsonValueSchema.optional(),
  source: z
    .object({
      implementationDiagnostics: z
        .array(
          z.object({
            code: z.string(),
            column: z.number(),
            line: z.number(),
            message: z.string(),
            path: z.string(),
          }),
        )
        .optional(),
    })
    .catchall(jsonValueSchema.optional()),
  sourceFiles: z.array(z.object({ content: z.string(), path: z.string() })).optional(),
});
const reportFilename = "report.json";

async function writeFile(filePath: string, content: string) {
  await writeRawFile(filePath, await formatWithOxfmt(filePath, content));
}
const readArchiveIndexEntry = async (filePath: string): Promise<ArchiveIndexEntry | null> => {
  try {
    const contents = await readFile(filePath, "utf-8");
    const value: unknown = JSON.parse(contents);
    return archivedIndexEntrySchema.parse(value);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
};

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
const { name, "report-dir": reportDirectory } = values;
const hasValidReportDirectory = reportDirectory !== undefined && reportDirectory !== "";
const hasValidName = name !== undefined && name !== "";
if (!hasValidReportDirectory || !hasValidName || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name)) {
  throw new Error("Supply --report-dir and a lowercase kebab-case --name");
}
const input = path.resolve(reportDirectory);
const reportContents = await readFile(path.join(input, reportFilename), "utf-8");
const reportJson: unknown = JSON.parse(reportContents);
const report = reportParser.parse(reportJson);
const timestamp = new Date(report.createdAt).toISOString();
const { subjectiveScore } = report.judge;
const subjectiveScoreLabel =
  subjectiveScore === undefined ? "Not available" : `${subjectiveScore}/100`;
const date = timestamp.slice(0, 10);
const time = timestamp.slice(11, 23).replaceAll(/[:.]/gu, "");
const archiveRoot = path.resolve("docs/reports/design-quality");
const relative = `${date}/${name}-${time}Z`;
const destination = path.join(archiveRoot, relative);
await mkdir(path.join(archiveRoot, date), { recursive: true });
// A report is a historical observation: never silently replace an existing run.
await mkdir(destination);
for (const capture of report.captures) {
  const filename = captureFilename(capture.name);
  await copyFile(path.join(input, filename), path.join(destination, filename));
  capture.path = filename;
}
report.archive = {
  archivedAt: new Date().toISOString(),
  evaluatedAt: timestamp,
  name,
  note: "Saved generated preview; advisory model judgment, not human-calibrated ground truth. Local machine paths omitted.",
};
await writeFile(path.join(destination, reportFilename), `${JSON.stringify(report, null, 2)}\n`);
await writeFile(path.join(destination, "index.html"), renderReport(report));
const md = (value: string | number | null) =>
  String(value).replaceAll(/[<>|]/gu, (c) => ({ "<": "&lt;", ">": "&gt;", "|": "\\|" })[c] ?? c);
const lines = [
  `# ${name} — ${timestamp}`,
  "",
  "[All reports](../../README.md) · [Interactive HTML report](index.html) · [Full measurements and scoring](report.json)",
  "",
  "GitHub renders this summary and the screenshots. Download or clone this folder to open the HTML report locally; GitHub does not serve it as a website.",
  "",
  `**Subjective design score:** ${subjectiveScoreLabel}. Model: ${report.judge.model ?? "not run"}. Rubric: ${report.judge.rubricVersion ?? "not run"}.`,
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
    ...Object.entries(a.dimensions).map(([dimensionName, value]) => {
      const percent = value.percent === null ? "n/a" : `${Math.round(value.percent)}%`;
      return `| ${dimensionName} | ${value.conforming} | ${value.nonconforming} | ${value.unassessed} | ${percent} (${value.conforming}/${value.assessed}) |`;
    }),
    "",
    "Scores from different evaluator versions or captured states are not directly comparable.",
    "",
  );
}
for (const [axis, rating] of Object.entries(report.judge.ratings ?? {})) {
  lines.push(`| ${md(axis)} | ${rating.score}/4 | ${md(rating.reason)} |`);
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
  for (const [category, summary] of Object.entries(capture.styles?.categories ?? {})) {
    const s = summary;
    lines.push(
      `| ${md(capture.name)} | ${md(category)} | ${capture.styles.observations?.filter((o) => o.category === category && o.provenance === "generated" && o.classification === "semantic-token-reference").length ?? s.counts["token-reference"] ?? 0}/${s.assessed} | ${s.coveragePercent ?? "n/a"}% (${s.assessed}/${s.total}) |`,
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
  score: string | number;
}[] = [];
for (const day of await readdir(archiveRoot, { withFileTypes: true })) {
  if (day.isDirectory() && /^\d{4}-\d{2}-\d{2}$/u.test(day.name)) {
    for (const run of await readdir(path.join(archiveRoot, day.name), {
      withFileTypes: true,
    })) {
      if (run.isDirectory()) {
        const saved = await readArchiveIndexEntry(
          path.join(archiveRoot, day.name, run.name, reportFilename),
        );
        if (saved !== null) {
          rows.push({
            date: saved.createdAt,
            name: saved.archive.name,
            path: `${day.name}/${run.name}`,
            score: saved.judge.subjectiveScore ?? "not scored",
          });
        }
      }
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
    ...rows.map((r) => `| ${r.date} | [${r.name}](${r.path}/README.md) | ${r.score} |`),
    "",
  ].join("\n"),
);
console.log(`Archived report: ${destination}`);
