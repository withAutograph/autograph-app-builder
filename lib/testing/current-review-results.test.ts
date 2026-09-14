import { describe, expect, it } from "vitest";
import { currentReviewResults, unavailableReviewReply } from "./current-review-results";

describe("mock review history", () => {
  it("discards rejected pre-validation review probes and retains current acceptance retries", () => {
    const stale = { isError: true, name: "change_set_status" };
    const proposal = { name: "change_set_status", output: { digest: "current" } };
    const acceptance = { name: "accept_change_set", output: { reused: false } };
    expect(
      currentReviewResults([stale, { name: "validate_app_creation" }, proposal, acceptance]),
    ).toEqual([proposal, acceptance]);
    expect(currentReviewResults([stale, { name: "validate_app_creation" }])).toEqual([]);
  });
  it("starts a new review after subsequent validation without treating old acceptance as current", () => {
    expect(
      currentReviewResults([
        { name: "validate_app_creation" },
        { name: "accept_change_set" },
        { name: "validate_app_creation" },
        { name: "workspace_status" },
      ]),
    ).toEqual([{ name: "workspace_status" }]);
  });
  it("excludes stale status while retaining the status after current validation", () => {
    const currentStatus = { name: "workspace_status", output: { phase: "validation_failed" } };
    expect(
      currentReviewResults([
        { name: "workspace_status", output: { phase: "validated" } },
        { name: "validate_app_creation" },
        currentStatus,
      ]),
    ).toEqual([currentStatus]);
  });
  it("terminates review honestly when current validation did not pass", () => {
    expect(unavailableReviewReply("validation_failed")).toContain("did not pass");
    expect(unavailableReviewReply("validation_pending")).toContain("did not finish");
    expect(unavailableReviewReply("applied")).toContain("must pass");
    expect(unavailableReviewReply("validated")).toBeUndefined();
    expect(unavailableReviewReply("reviewed")).toBeUndefined();
  });
});
