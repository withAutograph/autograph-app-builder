import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { desktopViewports } from "./self-reproduction-parity";

export type ObservationStatus = "passed" | "failed" | "blocked" | "unassessed";
export interface PreviewReceipt {
  expiresAt: string;
  url: string;
  verifiedAt: string;
}
export interface PreviewViewportObservation {
  brief?: { actualValue?: string; reason: string; status: ObservationStatus };
  consoleErrors: string[];
  controls: { name: string; role: string }[];
  pageErrors: string[];
  screenshot?: string;
  status: ObservationStatus;
  viewport: (typeof desktopViewports)[number];
}
export interface PreviewObservationReport {
  generatedAt: string;
  kind: "self-reproduction-working-preview-observation/v1";
  note: string;
  rows: { evidence: string[]; id: string; reason: string; status: ObservationStatus }[];
  sourceState: string;
  viewports: PreviewViewportObservation[];
}

const credentialPattern =
  /(?:authorization|bearer|token|secret|password|passwd|api[_-]?key)\s*[:=]\s*[^\s,;]+/giu;
const urlPattern = /(?:https?|wss?):\/\/[^\s"'<>]+/giu;
export const sanitizePreviewEvidence = (value: string) =>
  value
    .replaceAll(/\bbearer\s+[^\s,;]+/giu, "Bearer [REDACTED]")
    .replaceAll(credentialPattern, "[REDACTED CREDENTIAL]")
    .replaceAll(urlPattern, (raw) => {
      try {
        const url = new URL(raw);
        return `${url.protocol}//${url.host}/[REDACTED URL]`;
      } catch {
        return "[REDACTED URL]";
      }
    });

const sanitizeValue = (value: unknown): unknown => {
  if (typeof value === "string") {
    return sanitizePreviewEvidence(value);
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, sanitizeValue(item)]),
    );
  }
  return value;
};

export const loadWorkingPreview = async (
  statePath: string,
  nowMs = Date.now(),
): Promise<
  | { receipt: PreviewReceipt; status: "ready" }
  | { reason: string; status: "expired" | "missing" | "missing-final" | "invalid" }
> => {
  let state: unknown;
  try {
    state = JSON.parse(await readFile(statePath, "utf-8"));
  } catch {
    return { reason: "The owner-only state file was missing or invalid JSON.", status: "invalid" };
  }
  const publicState = state as {
    outcome?: string;
    session?: { status?: string; workingPreview?: unknown };
  };
  const receipt = publicState?.session?.workingPreview;
  if (!receipt || typeof receipt !== "object") {
    const finalWaiting =
      publicState.outcome === "waiting" && publicState.session?.status === "waiting";
    return {
      reason: finalWaiting
        ? "The final waiting public session did not deliver a working-preview receipt."
        : "The public eval state has no delivered working-preview receipt.",
      status: finalWaiting ? "missing-final" : "missing",
    };
  }
  const candidate = receipt as Partial<PreviewReceipt>;
  if (
    typeof candidate.url !== "string" ||
    typeof candidate.expiresAt !== "string" ||
    typeof candidate.verifiedAt !== "string"
  ) {
    return { reason: "The delivered working-preview receipt is incomplete.", status: "invalid" };
  }
  try {
    const url = new URL(candidate.url);
    if (url.protocol !== "https:" || url.username || url.password) {
      throw new Error("unsafe");
    }
  } catch {
    return { reason: "The delivered working-preview URL is invalid or unsafe.", status: "invalid" };
  }
  const expiration = Date.parse(candidate.expiresAt);
  if (!Number.isFinite(expiration)) {
    return { reason: "The delivered working-preview expiration is invalid.", status: "invalid" };
  }
  if (expiration <= nowMs) {
    return { reason: "The delivered working-preview receipt has expired.", status: "expired" };
  }
  return { receipt: candidate as PreviewReceipt, status: "ready" };
};

const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
export const writePreviewObservationReport = async (
  output: string,
  report: PreviewObservationReport,
) => {
  await mkdir(output, { mode: 0o700, recursive: true });
  const sanitized = sanitizeValue(report) as PreviewObservationReport;
  const json = `${JSON.stringify(sanitized, null, 2)}\n`;
  await writeFile(path.join(output, "report.json"), json, { mode: 0o600 });
  const rows = sanitized.rows
    .map((row) => `| ${row.id} | ${row.status} | ${row.reason.replaceAll("|", "\\|")} |`)
    .join("\n");
  await writeFile(
    path.join(output, "report.md"),
    `# Working-preview observation\n\n${
      sanitized.note
    }\n\n| Requirement | Status | Finding |\n| --- | --- | --- |\n${rows}\n`,
    { mode: 0o600 },
  );
  const htmlRows = sanitized.rows
    .map(
      (row) =>
        `<tr><th>${escapeHtml(row.id)}</th><td>${row.status}</td><td>${escapeHtml(
          row.reason,
        )}</td></tr>`,
    )
    .join("");
  const figures = sanitized.viewports
    .filter((item) => item.screenshot)
    .map(
      (item) =>
        `<figure><figcaption>${escapeHtml(item.viewport.name)}</figcaption><img src="${escapeHtml(
          item.screenshot ?? "",
        )}" alt="Preview"></figure>`,
    )
    .join("");
  await writeFile(
    path.join(output, "index.html"),
    `<!doctype html><meta charset="utf-8"><title>Working-preview observation</title><style>body{font:15px/1.5 system-ui;margin:32px auto;max-width:1440px;padding:0 24px}table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid #ddd;padding:10px;text-align:left}img{max-width:100%}</style><h1>Working-preview observation</h1><p>${escapeHtml(
      sanitized.note,
    )}</p><table><tr><th>Requirement</th><th>Status</th><th>Finding</th></tr>${htmlRows}</table>${
      figures
    }`,
    { mode: 0o600 },
  );
  return sanitized;
};

export const summarizePreviewRows = (
  viewports: PreviewViewportObservation[],
  briefRequested: boolean,
): PreviewObservationReport["rows"] => {
  const screenshots = viewports.flatMap((item) => (item.screenshot ? [item.screenshot] : []));
  let browserStatus: ObservationStatus = "unassessed";
  if (viewports.some((item) => item.status === "failed")) {
    browserStatus = "failed";
  } else if (viewports.some((item) => item.status === "blocked")) {
    browserStatus = "blocked";
  } else if (
    viewports.length === desktopViewports.length &&
    viewports.every((item) => item.status === "passed")
  ) {
    browserStatus = "passed";
  }
  const briefs = viewports.flatMap((item) => (item.brief ? [item.brief] : []));
  let briefStatus: ObservationStatus = "unassessed";
  if (briefRequested && briefs.some((item) => item.status === "failed")) {
    briefStatus = "failed";
  } else if (
    briefRequested &&
    briefs.length === desktopViewports.length &&
    briefs.every((item) => item.status === "passed")
  ) {
    briefStatus = "passed";
  }
  return [
    {
      evidence: [],
      id: "working-preview-receipt",
      reason: "Owner-only state contained an unexpired receipt.",
      status: "passed",
    },
    {
      evidence: screenshots,
      id: "browser-observation",
      reason:
        browserStatus === "passed"
          ? "All desktop viewports loaded without observed page, console, or script failures."
          : "Desktop observation was incomplete, failed, or blocked; inspect retained viewport evidence.",
      status: browserStatus,
    },
    {
      evidence: screenshots,
      id: "synthetic-brief-control",
      reason: briefRequested
        ? "Only executed semantic field and Continue assertions can pass this observation."
        : "No optional synthetic brief was supplied.",
      status: briefStatus,
    },
  ];
};

export const unavailablePreviewReport = (
  statePath: string,
  finding: Awaited<ReturnType<typeof loadWorkingPreview>>,
  now = new Date(),
): PreviewObservationReport => {
  let receiptStatus: ObservationStatus = "unassessed";
  if (finding.status === "expired") {
    receiptStatus = "blocked";
  } else if (finding.status === "missing-final") {
    receiptStatus = "failed";
  } else if (finding.status === "ready") {
    receiptStatus = "passed";
  }
  return {
    generatedAt: now.toISOString(),
    kind: "self-reproduction-working-preview-observation/v1",
    note: "Observation only. This report does not host, install, repair, publish, or award parity credit.",
    rows: [
      {
        evidence: [],
        id: "working-preview-receipt",
        reason: finding.status === "ready" ? "The receipt was available." : finding.reason,
        status: receiptStatus,
      },
      {
        evidence: [],
        id: "browser-observation",
        reason: "The delivered preview was not opened.",
        status: finding.status === "expired" ? "blocked" : "unassessed",
      },
    ],
    sourceState: path.basename(statePath),
    viewports: [],
  };
};
