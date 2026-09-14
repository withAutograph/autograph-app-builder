import { expect, it } from "vitest";

import { sourceReviewEvidenceDigest, unavailableSourceAssessment } from "./product-source-review";
import {
  currentProductSourceAssessment,
  retainProductRequest,
  reviewCurrentProductSource,
} from "./product-source-review-state";

it("retains the exact first request and later clarifications without replay duplication", () => {
  const first = retainProductRequest(
    { clarifications: [], original: null, sequences: [] },
    "Original request",
    "turn0:0",
    true,
  );
  const later = retainProductRequest(first, "Change one outcome", "turn1:0");
  expect(later).toMatchObject({
    clarifications: ["Change one outcome"],
    original: "Original request",
  });
  expect(retainProductRequest(later, "Change one outcome", "turn1:0")).toEqual(later);
});
it("marks moving source stale without throwing or granting failure/success", async () => {
  const result = await reviewCurrentProductSource(
    {
      appSpec: "spec",
      appSpecDigest: "spec",
      clarifications: [],
      files: [],
      omissions: [],
      originalRequest: "request",
      sourceDigest: "before",
    },
    true,
    () => "after",
    { get: () => null, set: () => {} },
  );
  expect(result).toMatchObject({ findings: [], reviewCompleted: false, status: "unassessed" });
  expect(result.reason).toContain("stale");
});

it("reuses only matching evidence and invalidates findings when implementation changes", async () => {
  const input = {
    appSpec: "spec",
    appSpecDigest: "spec",
    clarifications: [],
    files: [],
    omissions: [],
    originalRequest: "request",
    sourceDigest: "same",
  };
  const cached = {
    ...unavailableSourceAssessment(input, "Cited source failure"),
    reviewCompleted: true,
    status: "failed" as const,
  };
  const store = { get: () => cached, set: () => {} };
  const reused = await reviewCurrentProductSource(input, true, () => "same", store);
  expect(reused.status).toBe("failed");
  const changed = { ...input, sourceDigest: "changed" };
  const result = await reviewCurrentProductSource(changed, true, () => "changed", store);
  expect(result.status).toBe("unassessed");
  expect(result.evidenceDigest).toBe(sourceReviewEvidenceDigest(changed));
});

it("retains source failures only for the current source and request identity", () => {
  const input = {
    appSpec: "spec",
    appSpecDigest: "spec",
    clarifications: [],
    files: [],
    omissions: [],
    originalRequest: "request",
    sourceDigest: "source",
  };
  const assessment = {
    ...unavailableSourceAssessment(input, "failure"),
    status: "failed" as const,
  };
  const store = { get: () => assessment, set: () => {} };
  expect(currentProductSourceAssessment(input, store)?.status).toBe("failed");
  expect(
    currentProductSourceAssessment({ ...input, sourceDigest: "changed" }, store),
  ).toBeUndefined();
  expect(
    currentProductSourceAssessment({ ...input, appSpecDigest: "changed" }, store),
  ).toBeUndefined();
  expect(
    currentProductSourceAssessment({ ...input, clarifications: ["Changed scope"] }, store),
  ).toBeUndefined();
  expect(
    currentProductSourceAssessment({ ...input, originalRequest: null }, store),
  ).toBeUndefined();
});
