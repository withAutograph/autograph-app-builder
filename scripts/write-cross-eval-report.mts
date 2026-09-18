import { z } from "zod";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";

const notSupplied = "not supplied";
const supplementalOption = "--supplemental";
const improvements = [
  "failed-journal-recovery",
  "interrupted-local-publication",
  "local-publication-overlap",
  "pre-journal-local-publication",
  "precondition-failed-publication",
  "published-local-workflow-boundary",
  "succeeded-journal-recovery",
];
const statuses = ["passed", "failed", "blocked", "unassessed", "excluded"];
const assertionSchema = z.object({ passed: z.boolean().nullish(), severity: z.string().nullish() });
const evalSchema = z.object({
  // eslint-disable-next-line promise/prefer-await-to-then, github/no-then -- Zod synchronous malformed-input fallback, not a Promise.
  assertions: z.array(assertionSchema).catch([]),
  id: z.string(),
  verdict: z.string().optional(),
});
const summarySchema = z.object({
  command: z.string().optional(),
  evals: z.array(evalSchema),
  evidencePath: z.string().optional(),
  sourceRevision: z.string().optional(),
});
const inventorySchema = z
  .array(
    z.object({
      execution: z.string().optional(),
      group: z.string().optional(),
      id: z.string().regex(/^[a-z0-9-]+$/u),
    }),
  )
  .min(1);
const baselineSchema = z
  .object({
    rows: z
      .array(
        z.object({
          current: z
            .object({
              assessmentStatus: z.string().optional(),
              runnerOutcome: z.string().optional(),
            })
            .optional(),
          id: z.string().optional(),
          name: z.string().optional(),
        }),
      )
      // eslint-disable-next-line promise/prefer-await-to-then, github/no-then -- Zod synchronous missing-baseline fallback.
      .catch([]),
  })
  // eslint-disable-next-line promise/prefer-await-to-then, github/no-then -- Zod synchronous missing-baseline fallback.
  .catch({ rows: [] });
const supplementalSchema = z.object({
  scenarios: z
    .array(
      z.object({
        evidence: z.array(z.string()),
        id: z.string(),
        reason: z.string(),
        status: z.enum(["passed", "failed", "blocked", "unassessed", "excluded"]),
      }),
    )
    .default([]),
});
const assertionCounts = (assertions: z.infer<typeof assertionSchema>[]) => ({
  failed: assertions.filter((assertion) => assertion.passed === false).length,
  passed: assertions.filter((assertion) => assertion.passed === true).length,
  total: assertions.length,
});
const gateAssertion = (assertion: z.infer<typeof assertionSchema>) => assertion.severity === "gate";
const clean = (value: string | undefined): string =>
  (value ?? "")
    .replaceAll(/https?:\/\/[^\s<>"']+/giu, "[URL omitted]")
    .replaceAll(/Bearer\s+\S+/giu, "Bearer [redacted]")
    .replaceAll(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "[redacted]")
    .replaceAll(
      /\b(?:api[-_]?key|token|password|passwd|secret)\s*[:=]\s*[^\s,;]+/giu,
      "credential=[redacted]",
    )
    // eslint-disable-next-line eslint/no-control-regex -- Remove untrusted terminal controls.
    .replaceAll(/[\u0000-\u001F\u007F]/gu, " ")
    .slice(0, 1200);

const summaryProvenance = (
  summary: z.infer<typeof summarySchema> | undefined,
  revision: string,
) => ({
  command: clean(summary?.command),
  evidencePath: clean(summary?.evidencePath),
  revisionBasis:
    summary?.sourceRevision === undefined
      ? "declared report fallback; not inferred"
      : "declared on supplied summary; not inferred",
  sourceRevision: clean(summary?.sourceRevision ?? revision),
});
// eslint-disable-next-line eslint/func-style -- Export named report builder for focused testing.
export function buildCrossEvalReport(input: {
  inventory: unknown;
  summaries: unknown[];
  revision: string;
  baseline: unknown;
  supplemental?: unknown;
}) {
  const inventory = inventorySchema.parse(input.inventory);
  if (new Set(inventory.map((row) => row.id)).size !== inventory.length) {
    throw new Error("Duplicate inventory ids.");
  }
  const baseline = baselineSchema.parse(input.baseline).rows;
  const supplemental = supplementalSchema.parse(input.supplemental ?? {}).scenarios;
  const summaries = input.summaries.map((summary) => summarySchema.safeParse(summary));
  const unknownIds = summaries
    .flatMap((summary) => (summary.success ? summary.data.evals : []))
    .filter((row) => !inventory.some((item) => item.id === row.id))
    .map((row) => clean(row.id));
  const rows = inventory.map((item) => {
    const attempts = summaries.flatMap((parsedSummary, summaryIndex) =>
      (parsedSummary.success ? parsedSummary.data.evals : [])
        .filter((row) => row.id === item.id)
        .map((row) => {
          const summary = parsedSummary.data;
          const { assertions } = row;
          const gates = assertions.filter(gateAssertion);
          return {
            assertions: assertionCounts(assertions),
            gates: assertionCounts(gates),
            provenance: summaryProvenance(summary, input.revision),
            summaryIndex,
            verdict: ["passed", "failed", "errored", "skipped", "scored"].includes(
              String(row.verdict),
            )
              ? String(row.verdict)
              : "unknown",
          };
        }),
    );
    const runner = attempts.at(-1);
    let status = "unassessed";
    let reason = "No supplied runner evidence.";
    if (runner !== undefined) {
      reason = `Runner verdict ${runner.verdict}; missing, skipped, errored, or assertion-free evidence establishes no behavioral pass.`;
      if (runner.verdict === "failed") {
        status = "failed";
        reason = "Runner reported failure; cause not classified automatically.";
      } else if (
        runner.verdict === "passed" &&
        runner.assertions.total > 0 &&
        runner.assertions.failed === 0
      ) {
        status = "passed";
        reason =
          "Supplied runner assertions passed; this establishes only this scenario's declared scope.";
      }
    }
    const supplement = supplemental.find((row) => row.id === item.id);
    let evidence: string[] = [];
    if (supplement !== undefined) {
      evidence = supplement.evidence.map(clean).filter(Boolean);
      if (evidence.length === 0) {
        throw new Error(
          `Supplemental assessment for ${item.id} requires status, reason, and evidence.`,
        );
      }
      if (
        supplement.status === "passed" &&
        (runner?.verdict !== "passed" ||
          runner.assertions.total === 0 ||
          runner.assertions.failed > 0)
      ) {
        throw new Error(
          `Supplemental assessment requires passing nonempty runner evidence for ${item.id}.`,
        );
      }
      ({ status } = supplement);
      reason = clean(supplement.reason);
    }
    const before = baseline.find((row) => row.name === item.id || row.id === item.id);
    const previous = before?.current;
    return {
      assessment: { evidence, reason, status },
      attempts,
      baseline:
        before === undefined
          ? null
          : {
              assessmentStatus: clean(previous?.assessmentStatus),
              runnerVerdict: clean(previous?.runnerOutcome),
            },
      execution: clean(item.execution),
      group: clean(item.group),
      id: item.id,
      runner: runner ?? null,
      transition:
        before === undefined ? "no baseline" : `${clean(previous?.assessmentStatus)} → ${status}`,
    };
  });
  return {
    coverage: {
      assessmentCounts: Object.fromEntries(
        statuses.map((status) => [
          status,
          rows.filter((row) => row.assessment.status === status).length,
        ]),
      ),
      missing: rows.filter((row) => row.runner === null).length,
      observed: rows.filter((row) => row.runner !== null).length,
      total: rows.length,
      unknownSummaryIds: unknownIds,
    },
    evidenceScope:
      "Source revisions are caller declarations on each annotated summary or the report fallback; none are inferred or verified from Eve execution. Counts are runner evidence, not aggregate product-quality proof. Last supplied attempt selected; all attempts retained. Sanitization is bounded best effort; transcripts and target URLs are omitted.",
    improvements: improvements.map((id) => {
      const row = rows.find((item) => item.id === id);
      let preservation = "unassessed";
      if (
        row?.runner?.verdict === "passed" &&
        row.runner.assertions.failed === 0 &&
        row.runner.assertions.total > 0
      ) {
        preservation = "confirmed by runner";
      } else if (row?.runner?.verdict === "failed") {
        preservation = "regressed or blocked by failed scenario; diagnose";
      }
      return { id, preservation };
    }),
    inputIssues: summaries.flatMap((summary, index) =>
      summary.success
        ? []
        : [
            {
              reason:
                "Summary unavailable, malformed, or missing evals; associated scenarios remain unassessed unless other evidence exists.",
              summaryIndex: index,
            },
          ],
    ),
    kind: "cross-eval-assessment/v1",
    rows,
    sourceRevision: clean(input.revision),
  };
}

const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
const cell = (value: string) => value.replaceAll("|", "\\|").replaceAll("<", "&lt;");
// eslint-disable-next-line eslint/func-style -- Export named renderer for focused testing.
export function renderCrossEvalReport(report: ReturnType<typeof buildCrossEvalReport>) {
  const markdown = [
    `# Cross-eval assessment`,
    `Source: ${report.sourceRevision}`,
    report.evidenceScope,
    ...report.inputIssues.map((issue) => `Summary ${issue.summaryIndex}: ${issue.reason}`),
    `Observed ${report.coverage.observed}/${report.coverage.total} scenarios.`,
    "| Scenario | Runner | Gates | Assessment | Baseline change | Reason |",
    "|---|---|---|---|---|---|",
    ...report.rows.map(
      (row) =>
        `| ${row.id} | ${row.runner?.verdict ?? "missing"} | ${row.runner === null ? "unassessed" : [row.runner.gates.passed, row.runner.gates.total].join("/")} | ${row.assessment.status} | ${cell(row.transition)} | ${cell(row.assessment.reason)} |`,
    ),
    "",
    "## Attempt provenance",
    ...report.rows.flatMap((row) =>
      row.attempts.map(
        (attempt) =>
          `- ${row.id}, summary ${attempt.summaryIndex}, ${attempt.verdict}: ${cell(attempt.provenance.sourceRevision)} (${attempt.provenance.revisionBasis}); command: ${cell(attempt.provenance.command || notSupplied)}; evidence: ${cell(attempt.provenance.evidencePath || notSupplied)}`,
      ),
    ),
    "## Seven improvements",
    ...report.improvements.map((row) => `- ${row.id}: ${row.preservation}`),
  ].join("\n");
  const htmlRows = report.rows
    .map(
      (row) =>
        `<tr><td>${escapeHtml(row.id)}</td><td>${escapeHtml(row.runner?.verdict ?? "missing")}</td><td>${escapeHtml(row.assessment.status)}</td><td>${escapeHtml(row.transition)}</td><td>${escapeHtml(row.assessment.reason)}</td></tr>`,
    )
    .join("");
  const htmlAttempts = report.rows
    .flatMap((row) =>
      row.attempts.map(
        (attempt) =>
          `<li>${escapeHtml(row.id)}: ${escapeHtml(attempt.verdict)}; ${escapeHtml(attempt.provenance.sourceRevision)} (${escapeHtml(attempt.provenance.revisionBasis)}); command: ${escapeHtml(attempt.provenance.command || notSupplied)}; evidence: ${escapeHtml(attempt.provenance.evidencePath || notSupplied)}</li>`,
      ),
    )
    .join("");
  const htmlImprovements = report.improvements
    .map((row) => `<li>${escapeHtml(row.id)}: ${escapeHtml(row.preservation)}</li>`)
    .join("");
  return {
    html: `<!doctype html><html lang="en"><meta charset="utf-8"><title>Cross-eval assessment</title><style>body{font:15px system-ui;margin:32px;max-width:1400px}pre{white-space:pre-wrap;overflow-wrap:anywhere}table{border-collapse:collapse}td,th{text-align:left;vertical-align:top;padding:8px;border:1px solid #ddd}</style><h1>Cross-eval assessment</h1><p>${escapeHtml(report.evidenceScope)}</p><p>Source: ${escapeHtml(report.sourceRevision)}. Observed ${report.coverage.observed}/${report.coverage.total} scenarios.</p><table><thead><tr><th>Scenario</th><th>Runner</th><th>Assessment</th><th>Baseline change</th><th>Reason</th></tr></thead><tbody>${htmlRows}</tbody></table><h2>Attempt provenance</h2><ul>${htmlAttempts}</ul><h2>Seven improvements</h2><ul>${htmlImprovements}</ul><pre>${escapeHtml(JSON.stringify(report.inputIssues))}</pre></html>`,
    markdown,
  };
}

const jsonValueSchema = z.json();
type ReportJsonInput = z.infer<typeof jsonValueSchema>;
const read = (file: string): ReportJsonInput =>
  jsonValueSchema.parse(JSON.parse(readFileSync(file, "utf-8")));
// eslint-disable-next-line eslint/func-style -- Named CLI entrypoint.
function main() {
  const args = process.argv.slice(2);
  const values = new Map<string, string[]>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (
      key === undefined ||
      value === undefined ||
      ![
        "--inventory",
        "--summary",
        "--source-revision",
        "--baseline",
        "--output-dir",
        supplementalOption,
      ].includes(key)
    ) {
      throw new Error("Invalid report arguments.");
    }
    values.set(key, [...(values.get(key) ?? []), value]);
  }
  const required = (key: string) => {
    const result = values.get(key);
    if (result?.length !== 1 || result[0] === undefined) {
      throw new Error(`Exactly one ${key} is required.`);
    }
    return result[0];
  };
  const repository = realpathSync(path.resolve(import.meta.dirname, ".."));
  const output = path.resolve(required("--output-dir"));
  if (output === repository || output.startsWith(`${repository}${path.sep}`)) {
    throw new Error("Reports must be outside the source tree.");
  }
  mkdirSync(output, { recursive: true });
  const canonicalOutput = realpathSync(output);
  if (canonicalOutput === repository || canonicalOutput.startsWith(`${repository}${path.sep}`)) {
    throw new Error("Reports must be outside the source tree.");
  }
  const report = buildCrossEvalReport({
    baseline: read(required("--baseline")),
    inventory: read(required("--inventory")),
    revision: required("--source-revision"),
    summaries: (values.get("--summary") ?? []).map((file) => {
      try {
        return read(file);
      } catch {
        return null;
      }
    }),
    supplemental: values.has(supplementalOption) ? read(required(supplementalOption)) : undefined,
  });
  const rendered = renderCrossEvalReport(report);
  writeFileSync(path.join(output, "assessment.json"), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(path.join(output, "assessment.md"), rendered.markdown);
  writeFileSync(path.join(output, "index.html"), rendered.html);
}
if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === import.meta.filename) {
  main();
}
