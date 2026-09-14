import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import {
  loadWorkingPreview,
  sanitizePreviewEvidence,
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
    "https://preview.test/private?token=x wss://preview.test/socket?secret=x authorization: bearer-x";
  const result = sanitizePreviewEvidence(input);
  expect(result).not.toContain("private");
  expect(result).not.toContain("socket");
  expect(result).not.toContain("bearer-x");
  expect(input).toContain("token=x");
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
