import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import {
  loadWorkingPreview,
  sanitizePreviewEvidence,
  summarizePreviewRows,
  unavailablePreviewReport,
  writePreviewObservationReport,
} from "./self-reproduction-preview-observation";

const temp = () => mkdtemp(path.join(tmpdir(), "preview-observation-"));
it("keeps a missing receipt unassessed", async () => {
  const root = await temp();
  const state = path.join(root, "state.json");
  await writeFile(state, JSON.stringify({ session: { status: "waiting" } }));
  const finding = await loadWorkingPreview(state);
  expect(finding.status).toBe("missing");
  expect(unavailablePreviewReport(state, finding).rows.map((row) => row.status)).toEqual([
    "unassessed",
    "unassessed",
  ]);
});
it("fails delivery when a final waiting session has no receipt", async () => {
  const root = await temp();
  const state = path.join(root, "state.json");
  await writeFile(state, JSON.stringify({ outcome: "waiting", session: { status: "waiting" } }));
  const finding = await loadWorkingPreview(state);
  expect(finding.status).toBe("missing-final");
  expect(unavailablePreviewReport(state, finding).rows[0]?.status).toBe("failed");
});
it("blocks an expired receipt", async () => {
  const root = await temp();
  const state = path.join(root, "state.json");
  await writeFile(
    state,
    JSON.stringify({
      session: {
        workingPreview: {
          expiresAt: "2026-01-01T00:00:00.000Z",
          url: "https://preview.test/private?token=x",
          verifiedAt: "2025-12-31T00:00:00.000Z",
        },
      },
    }),
  );
  const finding = await loadWorkingPreview(state, Date.parse("2026-01-02T00:00:00.000Z"));
  expect(finding.status).toBe("expired");
  expect(
    unavailablePreviewReport(state, finding).rows.every((row) => row.status === "blocked"),
  ).toBe(true);
});
it("redacts http, websocket and credential material without mutating input", () => {
  const input =
    "https://preview.test/private?token=x wss://preview.test/socket?secret=x Authorization: Bearer secret Bearer second";
  const result = sanitizePreviewEvidence(input);
  expect(result).not.toContain("private");
  expect(result).not.toContain("socket");
  expect(result).not.toContain("secret");
  expect(result).not.toContain("second");
  expect(input).toContain("token=x");
});
it("never passes all-blocked or mixed partial observations", () => {
  const viewport = { height: 900, name: "desktop", width: 1440 } as const;
  const blocked = {
    consoleErrors: [],
    controls: [],
    pageErrors: [],
    status: "blocked" as const,
    viewport,
  };
  expect(summarizePreviewRows([blocked, blocked, blocked], true).map((row) => row.status)).toEqual([
    "passed",
    "blocked",
    "unassessed",
  ]);
  expect(summarizePreviewRows([{ ...blocked, status: "passed" }], true)[1]?.status).toBe(
    "unassessed",
  );
});
it("does not pass when all expected viewport rows are unassessed", () => {
  const viewports = [
    { height: 900, name: "desktop", width: 1440 },
    { height: 1080, name: "desktop-wide", width: 1920 },
    { height: 768, name: "desktop-window", width: 1024 },
  ] as const;
  const rows = summarizePreviewRows(
    viewports.map((viewport) => ({
      consoleErrors: [],
      controls: [],
      pageErrors: [],
      status: "unassessed" as const,
      viewport,
    })),
    false,
  );
  expect(rows[1]?.status).toBe("unassessed");
});
it("leaves an unfamiliar semantic field unassessed and retains partial successful viewports", () => {
  const viewport = { height: 900, name: "desktop", width: 1440 } as const;
  const rows = summarizePreviewRows(
    [
      {
        brief: { reason: "Unknown UI", status: "unassessed" },
        consoleErrors: [],
        controls: [],
        pageErrors: [],
        screenshot: "screenshots/desktop.png",
        status: "passed",
        viewport,
      },
      {
        consoleErrors: [],
        controls: [],
        pageErrors: ["later failure"],
        status: "blocked",
        viewport: { ...viewport, height: 1080, name: "desktop-wide", width: 1920 },
      },
    ],
    true,
  );
  expect(rows[1]).toMatchObject({ evidence: ["screenshots/desktop.png"], status: "blocked" });
  expect(rows[2]?.status).toBe("unassessed");
});
it("retains partial mixed-status evidence and redacts it", async () => {
  const root = await temp();
  await writePreviewObservationReport(root, {
    generatedAt: "2026-09-14T00:00:00.000Z",
    kind: "self-reproduction-working-preview-observation/v1",
    note: "Observation only.",
    rows: [
      { evidence: [], id: "receipt", reason: "Ready.", status: "passed" },
      {
        evidence: [],
        id: "browser",
        reason: "https://preview.test/private?token=x",
        status: "blocked",
      },
    ],
    sourceState: "state.json",
    viewports: [],
  });
  const output = await readFile(path.join(root, "report.json"), "utf-8");
  expect(output).toContain('"passed"');
  expect(output).toContain('"blocked"');
  expect(output).not.toContain("token=x");
});
it("retains invalid state as incomplete evidence instead of throwing", async () => {
  const root = await temp();
  const state = path.join(root, "state.json");
  await writeFile(state, "null");
  const finding = await loadWorkingPreview(state);
  expect(finding.status).toBe("invalid");
  expect(unavailablePreviewReport(state, finding).rows[1]?.status).toBe("unassessed");
});
it("binds browser evidence to the public session and source without copying its capability", async () => {
  const root = await temp();
  const state = path.join(root, "state.json");
  const receipt = {
    expiresAt: "2026-01-02T00:00:00.000Z",
    url: "https://preview.test/private?token=capability",
    verifiedAt: "2026-01-01T00:00:00.000Z",
  };
  await writeFile(
    state,
    JSON.stringify({
      session: { sessionId: "session-1", workingPreview: receipt },
      sourceRevision: "revision-1",
    }),
  );
  const finding = await loadWorkingPreview(state, Date.parse("2026-01-01T01:00:00.000Z"));
  expect(finding.status).toBe("ready");
  if (finding.status !== "ready") {
    throw new Error("Expected a ready receipt.");
  }
  expect(finding.provenance).toEqual({
    expiresAt: receipt.expiresAt,
    sessionId: "session-1",
    sourceRevision: "revision-1",
    verifiedAt: receipt.verifiedAt,
  });
  expect(JSON.stringify(finding.provenance)).not.toContain("capability");
});
