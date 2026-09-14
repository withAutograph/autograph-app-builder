import { z } from "zod";
import { chromium } from "playwright";

type ObserveHtml = (html: string) => Promise<UiPreviewBrowserObservation>;

export interface UiPreviewBrowserObservation {
  controlName: string;
  expectedText: string;
  status: "passed";
  viewport: "1440x900";
}

const previewResultSchema = z.object({
  data: z.object({
    result: z.object({
      isError: z.literal(false).optional(),
      kind: z.literal("tool-result"),
      output: z.object({ content: z.string() }),
      toolName: z.literal("record_ui_preview"),
    }),
  }),
  type: z.literal("action.result"),
});

export const extractRecordedUiPreviewHtml = (events: readonly unknown[]): string => {
  const results = events.map((event) => previewResultSchema.safeParse(event));
  const result = results.findLast((candidate) => candidate.success);
  if (result?.success !== true) {
    throw new Error("The eval did not receive a completed record_ui_preview HTML result.");
  }
  return result.data.data.result.output.content;
};

const observeRenewalReviewHtml: ObserveHtml = async (html) => {
  const browser = await chromium.launch({
    executablePath: process.env.APP_BUILDER_EVAL_BROWSER_EXECUTABLE,
    headless: true,
  });
  try {
    const page = await browser.newPage({ viewport: { height: 900, width: 1440 } });
    const failures: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") {
        failures.push(message.text());
      }
    });
    page.on("pageerror", (error) => failures.push(error.message));
    await page.setContent(html, { waitUntil: "networkidle" });
    if (failures.length > 0) {
      throw new Error(`The rendered preview reported browser errors: ${failures.join("; ")}`);
    }
    const expected = page.getByText("Mercury Labs", { exact: true });
    if (await expected.isVisible()) {
      throw new Error("Mercury Labs was visible before the All renewals action.");
    }
    const control = page.getByRole("button", { exact: true, name: "All renewals" });
    if (!(await control.isVisible()) || !(await control.isEnabled())) {
      throw new Error("The All renewals control is not available for interaction.");
    }
    await control.click();
    if (!(await expected.isVisible())) {
      throw new Error("All renewals did not reveal the Mercury Labs row.");
    }
    if (failures.length > 0) {
      throw new Error(`The rendered preview reported browser errors: ${failures.join("; ")}`);
    }
    return {
      controlName: "All renewals",
      expectedText: "Mercury Labs",
      status: "passed",
      viewport: "1440x900",
    };
  } finally {
    await browser.close();
  }
};

export const observeRecordedRenewalReview = async (
  events: readonly unknown[],
  observe: ObserveHtml = observeRenewalReviewHtml,
): Promise<UiPreviewBrowserObservation> => await observe(extractRecordedUiPreviewHtml(events));
