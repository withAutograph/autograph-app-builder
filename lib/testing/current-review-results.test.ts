import { describe, expect, it } from "vitest";
import { currentReviewResults } from "./current-review-results";

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
});
