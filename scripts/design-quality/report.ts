import type { Adherence, Observation } from "./evidence";

export function escapeHtml(value: unknown) {
  return String(value).replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );
}
export function renderReport(report: {
  createdAt: string;
  source: unknown;
  adherence?: Adherence;
  sourceFiles?: Array<{ path: string; content: string }>;
  reference?: unknown;
  evaluationNotes?: string[];
  judge: unknown;
  captures: Array<{
    name: string;
    state: string;
    measurements: unknown;
    styles?: unknown;
    interaction: unknown;
    width?: number;
    height?: number;
  }>;
}) {
  const pretty = (v: unknown) =>
    `<pre>${escapeHtml(JSON.stringify(v, (key, value) => (key === "observations" && Array.isArray(value) ? { count: value.length, details: "Download report.json for individual observations" } : value), 2))}</pre>`;
  const adherence = report.adherence;
  const pct = (n: number | null) =>
    n === null ? "Not assessed" : `${Math.round(n)}%`;
  const observations = adherence?.observations ?? [];
  const location = (o: Observation, index: number) => {
    const file = report.sourceFiles?.find((f) => f.path === o.source?.path);
    const line = o.source?.line ?? 1;
    const excerpt = file?.content
      .split("\n")
      .slice(Math.max(0, line - 2), line + 2)
      .map((text, offset) => `${Math.max(1, line - 1) + offset}: ${text}`)
      .join("\n");
    return `<article id="finding-${index}"><strong>${escapeHtml(o.classification ?? o.dimension)} · ${escapeHtml(o.verdict)}</strong><p>${escapeHtml(o.summary)}</p><small>${escapeHtml(o.evidence)} evidence${o.source ? ` · <a href="#source-${index}">${escapeHtml(o.source.path)}:${o.source.line}</a>` : ""}${o.capture ? ` · <a href="#${escapeHtml(o.capture)}">Screenshot region</a>` : ""}</small>${o.source ? `<details id="source-${index}"><summary>Source location: ${escapeHtml(o.source.path)}:${o.source.line}</summary>${excerpt ? `<pre>${escapeHtml(excerpt)}</pre>` : "Source text not supplied; location only."}</details>` : ""}</article>`;
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
        .map((o, index) => ({ o, index }))
        .filter(({ o }) =>
          group === "unknown"
            ? o.provenance === "unknown" ||
              (o.provenance === "generated" && o.verdict === "unassessed")
            : o.provenance === group &&
              (group === "shared" || o.verdict === "nonconforming"),
        );
      const visible = group === "unknown" ? entries.slice(0, 30) : entries;
      return `<details${group === "generated" ? " open" : ""}><summary>${title} (${entries.length})</summary>${visible.map(({ o, index }) => location(o, index)).join("") || "No findings in assessed evidence."}${visible.length < entries.length ? '<p>Showing 30 representative unknowns. <a href="report.json">Download every observation and source location</a>.</p>' : ""}</details>`;
    })
    .join("");
  const measuredSummary =
    (report.evaluationNotes?.length
      ? `<details><summary>Capture context and limitations</summary><ul>${report.evaluationNotes.map((note) => `<li>${escapeHtml(note)}</li>`).join("")}</ul></details>`
      : "") +
    (adherence
      ? `<h2>Arrusted adherence: ${adherence.score === null ? "Not assessed" : `${adherence.score}/100`} · ${escapeHtml(adherence.status)}</h2><p>Evidence coverage: ${pct(adherence.coveragePercent)}. Evaluator ${adherence.version}. This measures inspected evidence, not all rendered UI.</p><table><thead><tr><th>Dimension</th><th>Conforming</th><th>Nonconforming</th><th>Unassessed</th><th>Adherence</th><th>Static / browser</th></tr></thead><tbody>${Object.entries(
          adherence.dimensions,
        )
          .map(
            ([name, d]) =>
              `<tr><th>${escapeHtml(name)}</th><td>${d.conforming}</td><td>${d.nonconforming}</td><td>${d.unassessed}</td><td>${pct(d.percent)} (${d.conforming}/${d.assessed})</td><td>${d.staticCount} / ${d.browserCount}</td></tr>`,
          )
          .join(
            "",
          )}</tbody></table><p>${escapeHtml(adherence.method)}</p><ul>${adherence.limitations.map((l) => `<li>${escapeHtml(l)}</li>`).join("")}</ul>${groups}<details><summary>All adherence observations</summary><p><a href="report.json" download>Download all counts, declarations, locations, and observations as JSON</a>.</p></details>`
      : "<p>Historical report: this evaluation predates measured adherence scoring.</p>");
  const annotated = (c: {
    name: string;
    state: string;
    width?: number;
    height?: number;
  }) => {
    const overlays = observations
      .map((o, index) => ({ o, index }))
      .filter(
        ({ o }) =>
          o.capture === c.name && o.region && o.verdict === "nonconforming",
      )
      .map(({ o, index }) => {
        const r = o.region!;
        if (
          ![r.x, r.y, r.width, r.height, c.width, c.height].every(
            (v) => typeof v === "number" && Number.isFinite(v),
          ) ||
          !c.width ||
          !c.height
        )
          return "";
        return `<a class="region" href="#finding-${index}" title="${escapeHtml(o.summary)}" aria-label="${escapeHtml(o.summary)}" style="left:${(100 * r.x) / c.width}%;top:${(100 * r.y) / c.height}%;width:${(100 * r.width) / c.width}%;height:${(100 * r.height) / c.height}%"></a>`;
      })
      .join("");
    const aiOverlays = (judge.findings ?? [])
      .map((f, index) => ({ f, index }))
      .filter(({ f }) => f.image === c.name)
      .map(({ f, index }) => {
        const r = f.region;
        if (!c.width || !c.height || !Object.values(r).every(Number.isFinite))
          return "";
        return `<a class="region" href="#design-${index}" title="${escapeHtml(f.explanation)}" aria-label="${escapeHtml(f.explanation)}" style="left:${(100 * r.x) / c.width}%;top:${(100 * r.y) / c.height}%;width:${(100 * r.width) / c.width}%;height:${(100 * r.height) / c.height}%"></a>`;
      })
      .join("");
    return `<div class="capture"><img src="${escapeHtml(c.name)}.png" alt="${escapeHtml(c.name)} ${escapeHtml(c.state)} screenshot">${overlays}${aiOverlays}</div><a href="${escapeHtml(c.name)}.png">Original, unmodified screenshot</a>`;
  };
  const judge = report.judge as {
    status?: string;
    subjectiveScore?: number;
    reason?: string;
    ratings?: Record<string, { score: number; reason: string }>;
    strengths?: string[];
    findings?: Array<{
      image: string;
      severity: string;
      region: { x: number; y: number; width: number; height: number };
      explanation: string;
      improvement: string;
    }>;
    limitations?: string[];
  };
  const summary = `<p><strong>${judge.status === "complete" ? `Subjective design score: ${judge.subjectiveScore}/100` : escapeHtml(judge.reason ?? "AI scoring not run")}</strong></p><p>One model assessment; not an objective rating. Token adherence is reported separately below.</p>${
    judge.ratings
      ? `<table><thead><tr><th>Dimension</th><th>Rating</th><th>Reason</th></tr></thead><tbody>${Object.entries(
          judge.ratings,
        )
          .map(
            ([axis, r]) =>
              `<tr><th>${escapeHtml(axis)}</th><td>${r.score}/4</td><td>${escapeHtml(r.reason)}</td></tr>`,
          )
          .join("")}</tbody></table>`
      : ""
  }${judge.strengths?.length ? `<h3>Strengths</h3><ul>${judge.strengths.map((s) => `<li>${escapeHtml(s)}</li>`).join("")}</ul>` : ""}${judge.findings?.length ? `<h3>Recommended improvements</h3>${judge.findings.map((f, index) => `<article id="design-${index}"><h4>${escapeHtml(f.severity)} · <a href="#${escapeHtml(f.image)}">${escapeHtml(f.image)}</a></h4><p>${escapeHtml(f.explanation)}</p><p><strong>Improve:</strong> ${escapeHtml(f.improvement)}</p><small>Screenshot region: x ${f.region.x}, y ${f.region.y}, width ${f.region.width}, height ${f.region.height}</small></article>`).join("")}` : ""}`;
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Generated UI design report</title><style>body{font:16px/1.5 system-ui;margin:32px auto;padding:0 24px;max-width:1100px;color:#222}h1,h2{line-height:1.2}img{max-width:100%;height:auto;display:block}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f4f4f4;padding:16px;border-radius:8px}section,article{margin:32px 0}summary{cursor:pointer}a{color:#334ba0}table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:12px;border-bottom:1px solid #ddd;vertical-align:top}.capture{position:relative}.region{position:absolute;border:2px dashed #a94700;box-sizing:border-box}.region:focus{outline:3px solid blue}</style><main><h1>Generated UI design report</h1><p>Advisory evaluation of an existing preview. Not a release gate or proof of backend behavior.</p><p>${escapeHtml(report.createdAt)} · <a href="report.json" download>Download full evidence JSON</a></p>${measuredSummary}<h2>AI design review</h2>${summary}<details><summary>Full scoring metadata and limitations</summary>${pretty(report.judge)}</details><details><summary>Generated-source evidence and reference diagnostics</summary>${pretty({ source: report.source, reference: report.reference })}</details>${report.captures.map((c) => `<section id="${escapeHtml(c.name)}"><h2>${escapeHtml(c.name)} — ${escapeHtml(c.state)}</h2>${annotated(c)}<details><summary>Browser findings and interactions</summary>${pretty({ measurements: c.measurements, interaction: c.interaction })}</details><details><summary>Token evidence and coverage</summary>${pretty(c.styles ?? "See initial state for style evidence")}</details></section>`).join("")}</main></html>`;
}
