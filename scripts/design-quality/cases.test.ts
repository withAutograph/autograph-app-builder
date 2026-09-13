import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { appendReviewQuestions, listDesignCases, readDesignCase } from "./cases";

const metadata = {
  evidence: [{ path: "fixtures/vendor", repo: "example", status: "available" }],
  id: "vendor-review",
  notes: "Approved fixture only.",
  outcomes: ["Review action is clear."],
  reviewQuestions: ["Can reviewers find the next action?"],
  status: "ready",
  title: "Vendor review",
};

describe("design-quality cases", () => {
  it("lists metadata without reading case briefs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "design-cases-"));
    await mkdir(path.join(root, metadata.id));
    await writeFile(path.join(root, metadata.id, "case.json"), JSON.stringify(metadata));
    expect(await listDesignCases(root)).toEqual([
      { id: "vendor-review", status: "ready", title: "Vendor review" },
    ]);
  });

  it("loads the brief and keeps questions visibly separate", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "design-cases-"));
    await mkdir(path.join(root, metadata.id));
    await writeFile(path.join(root, metadata.id, "case.json"), JSON.stringify(metadata));
    await writeFile(path.join(root, metadata.id, "brief.md"), "Base brief\n");
    const designCase = await readDesignCase(metadata.id, root);
    expect(appendReviewQuestions(designCase.brief, designCase.reviewQuestions)).toBe(
      "Base brief\n\n---\n\nReview questions for this case:\n- Can reviewers find the next action?",
    );
  });

  it("rejects path-like case ids", async () => {
    await expect(readDesignCase("../outside")).rejects.toThrow();
  });
});
