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
  judge: unknown;
  captures: Array<{
    name: string;
    state: string;
    measurements: unknown;
    styles?: unknown;
    interaction: unknown;
  }>;
}) {
  const pretty = (v: unknown) =>
    `<pre>${escapeHtml(JSON.stringify(v, null, 2))}</pre>`;
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
  }${judge.strengths?.length ? `<h3>Strengths</h3><ul>${judge.strengths.map((s) => `<li>${escapeHtml(s)}</li>`).join("")}</ul>` : ""}${judge.findings?.length ? `<h3>Recommended improvements</h3>${judge.findings.map((f) => `<article><h4>${escapeHtml(f.severity)} · <a href="#${escapeHtml(f.image)}">${escapeHtml(f.image)}</a></h4><p>${escapeHtml(f.explanation)}</p><p><strong>Improve:</strong> ${escapeHtml(f.improvement)}</p><small>Screenshot region: x ${f.region.x}, y ${f.region.y}, width ${f.region.width}, height ${f.region.height}</small></article>`).join("")}` : ""}`;
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Generated UI design report</title><style>body{font:16px/1.5 system-ui;margin:32px auto;padding:0 24px;max-width:1100px;color:#222}h1,h2{line-height:1.2}img{max-width:100%;height:auto;border:1px solid #ddd}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f4f4f4;padding:16px;border-radius:8px}section,article{margin:32px 0}summary{cursor:pointer}a{color:#334ba0}table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:12px;border-bottom:1px solid #ddd;vertical-align:top}</style><main><h1>Generated UI design report</h1><p>Advisory evaluation of an existing preview. Not a release gate or proof of backend behavior.</p><p>${escapeHtml(report.createdAt)}</p><h2>AI design review</h2>${summary}<details><summary>Full scoring metadata and limitations</summary>${pretty(report.judge)}</details><h2>Generated-source evidence</h2>${pretty(report.source)}${report.captures.map((c) => `<section id="${escapeHtml(c.name)}"><h2>${escapeHtml(c.name)} — ${escapeHtml(c.state)}</h2><a href="${escapeHtml(c.name)}.png"><img src="${escapeHtml(c.name)}.png" alt="${escapeHtml(c.name)} ${escapeHtml(c.state)} screenshot"></a><details><summary>Browser findings and interactions</summary>${pretty({ measurements: c.measurements, interaction: c.interaction })}</details><details><summary>Token evidence and coverage</summary>${pretty(c.styles ?? "See initial state for style evidence")}</details></section>`).join("")}</main></html>`;
}
