import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
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
export interface PreviewSourceProvenance {
  expiresAt: string;
  sessionId: string | null;
  sourceRevision: string | null;
  verifiedAt: string;
}
export interface PreviewObservationReport {
  provenance?: PreviewSourceProvenance;
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

const previewStateSchema = z.looseObject({
  outcome: z.string().optional(),
  session: z
    .object({
      sessionId: z.string().nullable().optional(),
      status: z.string().optional(),
      workingPreview: z.unknown().optional(),
    })
    .optional(),
  sourceRevision: z.string().nullable().optional(),
});
const previewReceiptSchema = z.object({
  expiresAt: z.string(),
  url: z.string(),
  verifiedAt: z.string(),
});

const previewProvenance = (
  sourceRevision: string | null,
  sessionId: string | null,
  receipt: PreviewReceipt,
): PreviewSourceProvenance => ({
  expiresAt: receipt.expiresAt,
  sessionId,
  sourceRevision,
  verifiedAt: receipt.verifiedAt,
});

const isSafePreviewUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
};

export const loadWorkingPreview = async (
  statePath: string,
  nowMs = Date.now(),
): Promise<
  | { provenance: PreviewSourceProvenance; receipt: PreviewReceipt; status: "ready" }
  | {
      reason: string;
      status: Exclude<ObservationStatus, "passed" | "blocked" | "unassessed"> | "missing-final";
    }
> => {
  let state: z.infer<typeof previewStateSchema>;
  try {
    state = previewStateSchema.parse(JSON.parse(await readFile(statePath, "utf-8")));
  } catch {
    return { reason: "The owner-only state file was missing or invalid JSON.", status: "invalid" };
  }
  const publicState = state;
  const receiptResult = previewReceiptSchema.safeParse(publicState.session?.workingPreview);
  if (!receiptResult.success) {
    if (
      publicState.session?.workingPreview === undefined ||
      publicState.session.workingPreview === null
    ) {
      const finalWaiting =
        publicState.outcome === "waiting" && publicState.session?.status === "waiting";
      return {
        reason: finalWaiting
          ? "The final waiting public session did not deliver a working-preview receipt."
          : "The public eval state has no delivered working-preview receipt.",
        status: finalWaiting ? "missing-final" : "missing",
      };
    }
    return { reason: "The delivered working-preview receipt is incomplete.", status: "invalid" };
  }
  const receipt = receiptResult.data;
  if (!isSafePreviewUrl(receipt.url)) {
    return { reason: "The delivered working-preview URL is invalid or unsafe.", status: "invalid" };
  }
  const expiration = Date.parse(receipt.expiresAt);
  if (!Number.isFinite(expiration)) {
    return { reason: "The delivered working-preview expiration is invalid.", status: "invalid" };
  }
  if (expiration <= nowMs) {
    return { reason: "The delivered working-preview receipt has expired.", status: "expired" };
  }
  return {
    provenance: previewProvenance(
      publicState.sourceRevision,
      publicState.session?.sessionId,
      receipt,
    ),
    receipt,
    status: "ready",
  };
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
  const sanitized = {
    ...report,
    note: sanitizePreviewEvidence(report.note),
    provenance: report.provenance === undefined ? undefined : { ...report.provenance },
    rows: report.rows.map((row) => ({
      ...row,
      evidence: row.evidence.map(sanitizePreviewEvidence),
      id: sanitizePreviewEvidence(row.id),
      reason: sanitizePreviewEvidence(row.reason),
    })),
    viewports: report.viewports.map((item) => ({
      ...item,
      brief:
        item.brief === undefined
          ? undefined
          : {
              ...item.brief,
              actualValue:
                item.brief.actualValue === undefined
                  ? undefined
                  : sanitizePreviewEvidence(item.brief.actualValue),
              reason: sanitizePreviewEvidence(item.brief.reason),
            },
      consoleErrors: item.consoleErrors.map(sanitizePreviewEvidence),
      controls: item.controls.map((control) => ({
        name: sanitizePreviewEvidence(control.name),
        role: sanitizePreviewEvidence(control.role),
      })),
      pageErrors: item.pageErrors.map(sanitizePreviewEvidence),
      screenshot:
        item.screenshot === undefined ? undefined : sanitizePreviewEvidence(item.screenshot),
    })),
  } satisfies PreviewObservationReport;
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
  const figures: string[] = [];
  for (const item of sanitized.viewports) {
    if (item.screenshot !== undefined && item.screenshot !== "") {
      figures.push(
        `<figure><figcaption>${escapeHtml(item.viewport.name)}</figcaption><img src="${escapeHtml(item.screenshot)}" alt="Preview"></figure>`,
      );
    }
  }
  const figureMarkup = figures.join("");
  await writeFile(
    path.join(output, "index.html"),
    `<!doctype html><meta charset="utf-8"><title>Working-preview observation</title><style>body{font:15px/1.5 system-ui;margin:32px auto;max-width:1440px;padding:0 24px}table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid #ddd;padding:10px;text-align:left}img{max-width:100%}</style><h1>Working-preview observation</h1><p>${escapeHtml(
      sanitized.note,
    )}</p><table><tr><th>Requirement</th><th>Status</th><th>Finding</th></tr>${htmlRows}</table>${
      figureMarkup
    }`,
    { mode: 0o600 },
  );
  return sanitized;
};

export const summarizePreviewRows = (
  viewports: PreviewViewportObservation[],
  briefRequested: boolean,
): PreviewObservationReport["rows"] => {
  const screenshots = viewports.flatMap((item) =>
    item.screenshot !== undefined && item.screenshot !== "" ? [item.screenshot] : [],
  );
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
