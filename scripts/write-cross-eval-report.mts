import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";

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
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const clean = (value: unknown): string =>
  String(value ?? "")
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

// eslint-disable-next-line eslint/func-style -- Export named report builder for focused testing.
export function buildCrossEvalReport(input: {
  inventory: unknown;
  summaries: unknown[];
  revision: string;
  baseline: unknown;
  supplemental?: unknown;
}) {
  const inventory = list(input.inventory).map(record);
  if (
    inventory.length === 0 ||
    inventory.some((row) => typeof row.id !== "string" || !/^[a-z0-9-]+$/u.test(row.id))
  ) {
    throw new Error("Inventory must contain canonical scenario ids.");
  }
  if (new Set(inventory.map((row) => row.id)).size !== inventory.length) {
    throw new Error("Duplicate inventory ids.");
  }
  const baseline = list(record(input.baseline).rows).map(record);
  const supplemental = list(record(input.supplemental).scenarios).map(record);
  const unknownIds = input.summaries
    .flatMap((summary) => list(record(summary).evals).map(record))
    .filter((row) => !inventory.some((item) => item.id === row.id))
    .map((row) => clean(row.id));
  const rows = inventory.map((item) => {
    const attempts = input.summaries.flatMap((summary, summaryIndex) =>
      list(record(summary).evals)
        .map(record)
        .filter((row) => row.id === item.id)
        .map((row) => {
          const assertions = list(row.assertions).map(record);
          const gates = assertions.filter((assertion) => assertion.severity === "gate");
          return {
            assertions: {
              failed: assertions.filter((assertion) => assertion.passed === false).length,
              passed: assertions.filter((assertion) => assertion.passed === true).length,
              total: assertions.length,
            },
            gates: {
              failed: gates.filter((assertion) => assertion.passed === false).length,
              passed: gates.filter((assertion) => assertion.passed === true).length,
              total: gates.length,
            },
            provenance: {
              command: clean(record(summary).command),
              evidencePath: clean(record(summary).evidencePath),
              revisionBasis:
                typeof record(summary).sourceRevision === "string"
                  ? "declared on supplied summary; not inferred"
                  : "declared report fallback; not inferred",
              sourceRevision: clean(record(summary).sourceRevision ?? input.revision),
            },
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
      evidence = list(supplement.evidence).map(clean).filter(Boolean);
      if (
        !statuses.includes(String(supplement.status)) ||
        typeof supplement.reason !== "string" ||
        evidence.length === 0
      ) {
        throw new Error(
          `Supplemental assessment for ${item.id} requires status, reason, and evidence.`,
        );
      }
      if (
        supplement.status === "passed" &&
        (runner?.verdict === "failed" || (runner?.assertions.failed ?? 0) > 0)
      ) {
        throw new Error(
          `Supplemental assessment cannot pass failed runner evidence for ${item.id}.`,
        );
      }
      status = String(supplement.status);
      reason = clean(supplement.reason);
    }
    const before = baseline.find((row) => row.name === item.id || row.id === item.id);
    const previous = record(before?.current);
    return {
      assessment: { evidence, reason, status },
      attempts,
      baseline:
        before === undefined
          ? null
          : {
              assessmentStatus: clean(previous.assessmentStatus),
              runnerVerdict: clean(previous.runnerOutcome),
            },
      execution: clean(item.execution),
      group: clean(item.group),
      id: String(item.id),
      runner: runner ?? null,
      transition:
        before === undefined ? "no baseline" : `${clean(previous.assessmentStatus)} → ${status}`,
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
    inputIssues: input.summaries.flatMap((summary, index) =>
      Array.isArray(record(summary).evals)
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

const escape = (value: string) =>
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
        `| ${row.id} | ${row.runner?.verdict ?? "missing"} | ${row.runner === null ? "unassessed" : `${row.runner.gates.passed}/${row.runner.gates.total}`} | ${row.assessment.status} | ${cell(row.transition)} | ${cell(row.assessment.reason)} |`,
    ),
    "",
    "## Attempt provenance",
    ...report.rows.flatMap((row) =>
      row.attempts.map(
        (attempt) =>
          `- ${row.id}, summary ${attempt.summaryIndex}, ${attempt.verdict}: ${cell(attempt.provenance.sourceRevision)} (${attempt.provenance.revisionBasis}); command: ${cell(attempt.provenance.command || "not supplied")}; evidence: ${cell(attempt.provenance.evidencePath || "not supplied")}`,
      ),
    ),
    "## Seven improvements",
    ...report.improvements.map((row) => `- ${row.id}: ${row.preservation}`),
  ].join("\n");
  return {
    html: `<!doctype html><html lang="en"><meta charset="utf-8"><title>Cross-eval assessment</title><style>body{font:15px system-ui;margin:32px;max-width:1400px}pre{white-space:pre-wrap;overflow-wrap:anywhere}table{border-collapse:collapse}td,th{text-align:left;vertical-align:top;padding:8px;border:1px solid #ddd}</style><h1>Cross-eval assessment</h1><p>${escape(report.evidenceScope)}</p><p>Source: ${escape(report.sourceRevision)}. Observed ${report.coverage.observed}/${report.coverage.total} scenarios.</p><table><thead><tr><th>Scenario</th><th>Runner</th><th>Assessment</th><th>Baseline change</th><th>Reason</th></tr></thead><tbody>${report.rows.map((row) => `<tr><td>${escape(row.id)}</td><td>${escape(row.runner?.verdict ?? "missing")}</td><td>${escape(row.assessment.status)}</td><td>${escape(row.transition)}</td><td>${escape(row.assessment.reason)}</td></tr>`).join("")}</tbody></table><h2>Attempt provenance</h2><ul>${report.rows.flatMap((row) => row.attempts.map((attempt) => `<li>${escape(row.id)}: ${escape(attempt.verdict)}; ${escape(attempt.provenance.sourceRevision)} (${escape(attempt.provenance.revisionBasis)}); command: ${escape(attempt.provenance.command || "not supplied")}; evidence: ${escape(attempt.provenance.evidencePath || "not supplied")}</li>`)).join("")}</ul><h2>Seven improvements</h2><ul>${report.improvements.map((row) => `<li>${escape(row.id)}: ${escape(row.preservation)}</li>`).join("")}</ul><pre>${escape(JSON.stringify(report.inputIssues))}</pre></html>`,
    markdown,
  };
}

const read = (file: string): unknown => JSON.parse(readFileSync(file, "utf-8"));
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
        "--supplemental",
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
    supplemental: values.has("--supplemental") ? read(required("--supplemental")) : undefined,
  });
  const rendered = renderCrossEvalReport(report);
  writeFileSync(path.join(output, "assessment.json"), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(path.join(output, "assessment.md"), rendered.markdown);
  writeFileSync(path.join(output, "index.html"), rendered.html);
}
if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === import.meta.filename) {
  main();
}
