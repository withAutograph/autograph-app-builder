import type { Adherence, Observation } from "./evidence";
import type { Judgment } from "./judge";
import type { SourceAnalysis, SourceFile } from "./source";

type ImplementationDiagnostic = SourceAnalysis["implementationDiagnostics"][number];
type ReportSource = Partial<Pick<SourceAnalysis, "implementationDiagnostics">>;
type ReportJudge = Partial<Judgment> & {
  reason?: string;
  status?: string;
  subjectiveScore?: number;
};
type ReportValue =
  | null
  | boolean
  | number
  | string
  | ReportValue[]
  | { [key: string]: ReportValue | undefined };
type EscapableValue = string | number | boolean | null | undefined;

export function escapeHtml(value: EscapableValue) {
  return String(value).replaceAll(
    /[&<>"']/gu,
    (char) =>
      ({ '"': "&quot;", "&": "&amp;", "'": "&#39;", "<": "&lt;", ">": "&gt;" })[char] ?? char,
  );
}
// Keep report rendering helpers scoped to the report artifact.
export function renderReport(report: {
  createdAt: string;
  source: ReportSource;
  adherence?: Adherence;
  sourceFiles?: SourceFile[];
  reference?: ReportValue;
  evaluationNotes?: string[];
  case?: {
    id: string;
    title: string;
    notes: string;
    evidence: { repo: string; path: string; status: string }[];
    reviewQuestions: string[];
    outcomes: string[];
  };
  judge: ReportJudge;
  captures: {
    name: string;
    state: string;
    measurements: ReportValue;
    styles?: ReportValue;
    interaction: ReportValue;
    width?: number;
    height?: number;
  }[];
}) {
  const pretty = (reportValue: ReportValue) => {
    const json = JSON.stringify(
      reportValue,
      (key: string, nestedValue: ReportValue | undefined): ReportValue | undefined =>
        key === "observations" && Array.isArray(nestedValue)
          ? {
              count: nestedValue.length,
              details: "Download report.json for individual observations",
            }
          : nestedValue,
      2,
    );
    return `<pre>${escapeHtml(json)}</pre>`;
  };
  const { adherence } = report;
  // Keep report formatting helpers local to this artifact.
  const pct = (n: number | null) => (n === null ? "Not assessed" : `${Math.round(n * 100) / 100}%`);
  const observations = adherence?.observations ?? [];
  const location = (o: Observation, index: number) => {
    const candidate = o.originCandidate;
    const candidateNote =
      candidate === undefined
        ? ""
        : `<p>Possible generated source (unassessed): ${escapeHtml(
            candidate.source.path,
          )}:${escapeHtml(candidate.source.line)}. ${escapeHtml(candidate.reason)}</p>`;
    const file = report.sourceFiles?.find((f) => f.path === o.source?.path);
    const line = o.source?.line ?? 1;
    const excerpt = file?.content
      .split("\n")
      .slice(Math.max(0, line - 2), line + 2)
      .map((text, offset) => `${Math.max(1, line - 1) + offset}: ${text}`)
      .join("\n");
    const sourceLink =
      o.source === undefined
        ? ""
        : ` · <a href="#source-${index}">${escapeHtml(o.source.path)}:${o.source.line}</a>`;
    const captureLink =
      o.capture === undefined ? "" : ` · <a href="#${escapeHtml(o.capture)}">Screenshot region</a>`;
    let excerptHtml = "";
    if (o.source !== undefined) {
      const excerptContent =
        excerpt === undefined
          ? "Source text not supplied; location only."
          : `<pre>${escapeHtml(excerpt)}</pre>`;
      excerptHtml = `<details id="source-${index}"><summary>Source location: ${escapeHtml(o.source.path)}:${o.source.line}</summary>${excerptContent}</details>`;
    }
    const heading = `${escapeHtml(o.classification ?? o.dimension)} · ${escapeHtml(o.verdict)}`;
    return `<article id="finding-${index}"><strong>${heading}</strong><p>${escapeHtml(o.summary)}</p>${candidateNote}<small>${escapeHtml(o.evidence)} evidence${sourceLink}${captureLink}</small>${excerptHtml}</article>`;
  };
  const groups = (
    [
      ["generated", "Generated-code changes"],
      ["shared", "Shared-library observations"],
      ["unknown", "Manual-review unknowns"],
    ] as const
  )
    .map(([group, title]) => {
      const entries = observations
        .map((o, index) => ({ index, o }))
        .filter(({ o }) => {
          if (group === "unknown") {
            return (
              o.provenance === "unknown" ||
              (o.provenance === "generated" && o.verdict === "unassessed")
            );
          }
          if (o.provenance !== group) {
            return false;
          }
          return group === "shared" || o.verdict === "nonconforming";
        });
      const visible = group === "unknown" ? entries.slice(0, 30) : entries;
      const renderedEntries = visible.map(({ o, index }) => location(o, index)).join("");
      const noFindings = renderedEntries.length === 0 ? "No findings in assessed evidence." : "";
      const remainder =
        visible.length < entries.length
          ? '<p>Showing 30 representative unknowns. <a href="report.json">Download every observation and source location</a>.</p>'
          : "";
      const open = group === "generated" ? " open" : "";
      return `<details${open}><summary>${title} (${entries.length})</summary>${renderedEntries}${noFindings}${remainder}</details>`;
    })
    .join("");
  const implementationDiagnostics: ImplementationDiagnostic[] =
    report.source.implementationDiagnostics ?? [];
  const implementationFindings =
    implementationDiagnostics.length > 0
      ? `<details open><summary>Generated-code implementation diagnostics (${implementationDiagnostics.length})</summary>${implementationDiagnostics
          .map((diagnostic, index) => {
            const file = report.sourceFiles?.find(
              (candidate) => candidate.path === diagnostic.path,
            );
            const excerpt = file?.content
              .split("\n")
              .slice(Math.max(0, diagnostic.line - 2), diagnostic.line + 1)
              .map((text, offset) => `${Math.max(1, diagnostic.line - 1) + offset}: ${text}`)
              .join("\n");
            const excerptContent =
              excerpt === undefined
                ? "Source text not supplied; location only."
                : `<pre>${escapeHtml(excerpt)}</pre>`;
            return `<article id="implementation-${index}"><strong>TypeScript ${escapeHtml(diagnostic.code)}</strong><p>${escapeHtml(diagnostic.message)}</p><small>Generated source · <a href="#implementation-source-${index}">${escapeHtml(diagnostic.path)}:${diagnostic.line}:${diagnostic.column}</a></small><details id="implementation-source-${index}"><summary>Source location</summary>${excerptContent}</details></article>`;
          })
          .join("")}</details>`
      : "";
  let measuredSummary = "";
  if (report.case !== undefined) {
    const caseEvidence = report.case.evidence
      .map(
        (item) =>
          `<li>${escapeHtml(item.repo)}: <code>${escapeHtml(item.path)}</code> — ${escapeHtml(item.status)}</li>`,
      )
      .join("");
    const questions = report.case.reviewQuestions
      .map((question) => `<li>${escapeHtml(question)}</li>`)
      .join("");
    const outcomes = report.case.outcomes
      .map((outcome) => `<li>${escapeHtml(outcome)}</li>`)
      .join("");
    measuredSummary += `<section><h2>${escapeHtml(report.case.title)}</h2><p>${escapeHtml(report.case.notes)}</p><details><summary>Case evidence and review questions</summary><ul>${caseEvidence}</ul><h3>Review questions</h3><ul>${questions}</ul><h3>Intended outcomes, not asserted results</h3><ul>${outcomes}</ul></details></section>`;
  }
  if (report.evaluationNotes !== undefined && report.evaluationNotes.length > 0) {
    const notes = report.evaluationNotes.map((note) => `<li>${escapeHtml(note)}</li>`).join("");
    measuredSummary += `<details><summary>Capture context and limitations</summary><ul>${notes}</ul></details>`;
  }
  if (adherence === undefined) {
    measuredSummary +=
      "<p>Historical report: this evaluation predates measured adherence scoring.</p>";
  } else {
    const adherenceScore = adherence.score === null ? "Not assessed" : `${adherence.score}/100`;
    const dimensionRows = Object.entries(adherence.dimensions)
      .map(
        ([name, d]) =>
          `<tr><th>${escapeHtml(name)}</th><td>${d.conforming}</td><td>${d.nonconforming}</td><td>${d.unassessed}</td><td>${pct(d.percent)} (${d.conforming}/${d.assessed})</td><td>${d.staticCount} / ${d.browserCount}</td></tr>`,
      )
      .join("");
    const limitations = adherence.limitations
      .map((limitation) => `<li>${escapeHtml(limitation)}</li>`)
      .join("");
    measuredSummary += `<h2>Arrusted adherence: ${adherenceScore} · ${escapeHtml(adherence.status)}</h2><p>Evidence coverage: ${pct(adherence.coveragePercent)}. Evaluator ${adherence.version}. This measures inspected evidence, not all rendered UI.</p><table><thead><tr><th>Dimension</th><th>Conforming</th><th>Nonconforming</th><th>Unassessed</th><th>Adherence</th><th>Static / browser</th></tr></thead><tbody>${dimensionRows}</tbody></table><p>${escapeHtml(adherence.method)}</p><ul>${limitations}</ul>${groups}<details><summary>All adherence observations</summary><p><a href="report.json" download>Download all counts, declarations, locations, and observations as JSON</a>.</p></details>`;
  }
  measuredSummary += implementationFindings;
  const { judge } = report;
  const annotated = (c: { name: string; state: string; width?: number; height?: number }) => {
    const overlays = observations
      .map((o, index) => ({ index, o }))
      .filter(
        ({ o }) => o.capture === c.name && o.region !== undefined && o.verdict === "nonconforming",
      )
      .map(({ o, index }) => {
        const r = o.region;
        if (r === undefined) {
          return "";
        }
        const dimensions = [r.x, r.y, r.width, r.height, c.width, c.height];
        const finiteDimensions = dimensions.every(
          (dimension) => dimension !== undefined && Number.isFinite(dimension),
        );
        const hasUsableCaptureSize =
          c.width !== undefined && c.height !== undefined && c.width !== 0 && c.height !== 0;
        if (!finiteDimensions || !hasUsableCaptureSize) {
          return "";
        }
        return `<a class="region" href="#finding-${index}" title="${escapeHtml(o.summary)}" aria-label="${escapeHtml(o.summary)}" style="left:${(100 * r.x) / c.width}%;top:${(100 * r.y) / c.height}%;width:${(100 * r.width) / c.width}%;height:${(100 * r.height) / c.height}%"></a>`;
      })
      .join("");
    const aiOverlays = (judge.findings ?? [])
      .map((f, index) => ({ f, index }))
      .filter(({ f }) => f.image === c.name)
      .map(({ f, index }) => {
        const r = f.region;
        const hasUsableCaptureSize =
          c.width !== undefined && c.height !== undefined && c.width !== 0 && c.height !== 0;
        const hasFiniteRegion = Object.values(r).every(Number.isFinite);
        if (!hasUsableCaptureSize || !hasFiniteRegion) {
          return "";
        }
        return `<a class="region" href="#design-${index}" title="${escapeHtml(f.explanation)}" aria-label="${escapeHtml(f.explanation)}" style="left:${(100 * r.x) / c.width}%;top:${(100 * r.y) / c.height}%;width:${(100 * r.width) / c.width}%;height:${(100 * r.height) / c.height}%"></a>`;
      })
      .join("");
    return `<div class="capture"><img src="${escapeHtml(c.name)}.png" alt="${escapeHtml(c.name)} ${escapeHtml(c.state)} screenshot">${overlays}${aiOverlays}</div><a href="${escapeHtml(c.name)}.png">Original, unmodified screenshot</a>`;
  };
  const judgeSummary =
    judge.status === "complete"
      ? `Subjective design score: ${escapeHtml(judge.subjectiveScore)}/100`
      : escapeHtml(judge.reason ?? "AI scoring not run");
  let ratingsHtml = "";
  if (judge.ratings !== undefined) {
    const ratingRows = Object.entries(judge.ratings)
      .map(
        ([axis, rating]) =>
          `<tr><th>${escapeHtml(axis)}</th><td>${rating.score}/4</td><td>${escapeHtml(rating.reason)}</td></tr>`,
      )
      .join("");
    ratingsHtml = `<table><thead><tr><th>Dimension</th><th>Rating</th><th>Reason</th></tr></thead><tbody>${ratingRows}</tbody></table>`;
  }
  const strengthItems =
    judge.strengths?.map((strength) => `<li>${escapeHtml(strength)}</li>`).join("") ?? "";
  const strengthsHtml =
    judge.strengths === undefined || judge.strengths.length === 0
      ? ""
      : `<h3>Strengths</h3><ul>${strengthItems}</ul>`;
  const findingsHtml =
    judge.findings === undefined || judge.findings.length === 0
      ? ""
      : `<h3>Recommended improvements</h3>${judge.findings
          .map(
            (finding, index) =>
              `<article id="design-${index}"><h4>${escapeHtml(finding.severity)} · <a href="#${escapeHtml(finding.image)}">${escapeHtml(finding.image)}</a></h4><p>${escapeHtml(finding.explanation)}</p><p><strong>Improve:</strong> ${escapeHtml(finding.improvement)}</p><small>Screenshot region: x ${finding.region.x}, y ${finding.region.y}, width ${finding.region.width}, height ${finding.region.height}</small></article>`,
          )
          .join("")}`;
  const summary = `<p><strong>${judgeSummary}</strong></p><p>One model assessment; not an objective rating. Token adherence is reported separately below.</p>${ratingsHtml}${strengthsHtml}${findingsHtml}`;
  const capturesHtml = report.captures
    .map((capture) => {
      const interaction = pretty({
        interaction: capture.interaction,
        measurements: capture.measurements,
      });
      const styles = pretty(capture.styles ?? "See initial state for style evidence");
      return `<section id="${escapeHtml(capture.name)}"><h2>${escapeHtml(capture.name)} — ${escapeHtml(capture.state)}</h2>${annotated(capture)}<details><summary>Browser findings and interactions</summary>${interaction}</details><details><summary>Token evidence and coverage</summary>${styles}</details></section>`;
    })
    .join("");
  // SAFETY: Source analysis is produced from the report domain model and contains only JSON report data.
  const reportSource = pretty({
    reference: report.reference,
    source: report.source as ReportValue,
  });
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Generated UI design report</title><style>body{font:16px/1.5 system-ui;margin:32px auto;padding:0 24px;max-width:1100px;color:#222}h1,h2{line-height:1.2}img{max-width:100%;height:auto;display:block}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f4f4f4;padding:16px;border-radius:8px}section,article{margin:32px 0}summary{cursor:pointer}a{color:#334ba0}table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:12px;border-bottom:1px solid #ddd;vertical-align:top}.capture{position:relative}.region{position:absolute;border:2px dashed #a94700;box-sizing:border-box}.region:focus{outline:3px solid blue}</style><main><h1>Generated UI design report</h1><p>Advisory evaluation of an existing preview. Not a release gate or proof of backend behavior.</p><p>${escapeHtml(report.createdAt)} · <a href="report.json" download>Download full evidence JSON</a></p>${measuredSummary}<h2>AI design review</h2>${summary}<details><summary>Full scoring metadata and limitations</summary>${pretty(judge)}</details><details><summary>Generated-source evidence and reference diagnostics</summary>${reportSource}</details>${capturesHtml}</main></html>`;
}
