import { describe, expect, it, vi } from "vitest";

import { extractRecordedUiPreviewHtml, observeRecordedRenewalReview } from "./ui-preview-browser";

const completedPreviewEvent = (content: string) => ({
  data: {
    result: {
      isError: false,
      kind: "tool-result",
      output: { content },
      toolName: "record_ui_preview",
    },
  },
  type: "action.result",
});

describe("recorded UI preview browser observation", () => {
  it("extracts only completed record_ui_preview HTML", () => {
    expect(
      extractRecordedUiPreviewHtml([
        completedPreviewEvent("<html>first</html>"),
        { ...completedPreviewEvent("<html>failed</html>"), data: { result: { isError: true } } },
        completedPreviewEvent("<html>current</html>"),
      ]),
    ).toBe("<html>current</html>");
  });

  it("fails when genuine compiled preview evidence is missing", () => {
    expect(() => extractRecordedUiPreviewHtml([])).toThrow(
      "The eval did not receive a completed record_ui_preview HTML result.",
    );
  });

  it("passes the genuine compiled HTML to the browser observer", async () => {
    const observe = vi.fn().mockResolvedValue({
      controlName: "All renewals",
      expectedText: "Mercury Labs",
      status: "passed",
      viewport: "1440x900",
    });
    await expect(
      observeRecordedRenewalReview([completedPreviewEvent("<html>compiled</html>")], observe),
    ).resolves.toMatchObject({ status: "passed" });
    expect(observe).toHaveBeenCalledExactlyOnceWith("<html>compiled</html>");
  });
});
