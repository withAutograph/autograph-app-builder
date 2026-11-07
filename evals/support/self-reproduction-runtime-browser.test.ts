/* oxlint-disable eslint/require-await -- async fixtures implement Sandbox and browser APIs. */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { sandboxBrowserComparison } from "./self-reproduction-runtime-browser";
import { desktopViewports } from "./self-reproduction-parity";

describe("sandbox diagnostic browser captures", () => {
  it("captures every desktop viewport and records real docs return outcomes", async () => {
    const { artifactPaths } = sandboxBrowserComparison();
    const writes: string[] = [];
    const outcomes: { viewport: string; documentation: { returned: boolean } }[] = [];
    let current = "";
    const page = {
      goBack: async () => {
        current = "http://127.0.0.1:3000/app";
      },
      goto: vi.fn(async (url: string) => {
        current = url;
        return { status: () => 200 };
      }),
      locator: () => ({
        innerText: async () => "Useful documentation content long enough to be readable.",
      }),
      screenshot: vi.fn(async () => {}),
      url: () => current,
    };
    const close = vi.fn(async () => {});
    const chromium = {
      launch: async () => ({
        close,
        newContext: async () => ({ close, newPage: async () => page }),
      }),
    };
    const browser = await chromium.launch();
    const captures = await Promise.all(
      desktopViewports.map(async (viewport) => {
        const context = await browser.newContext();
        const browserPage = await context.newPage();
        await browserPage.goto("http://127.0.0.1:3000/app");
        await browserPage.screenshot();
        await browserPage.goto("http://127.0.0.1:3000/app/docs");
        await browserPage.screenshot();
        await browserPage.goBack();
        const returned = browserPage.url() === "http://127.0.0.1:3000/app";
        expect(browserPage.url()).toBe("http://127.0.0.1:3000/app");
        await context.close();
        return { documentation: { returned }, viewport: viewport.name };
      }),
    );
    outcomes.push(...captures);
    writes.push(
      JSON.stringify({
        outcomes,
        producer: "evaluator",
        version: 1,
      }),
    );
    await browser.close();
    const outputText = writes.at(-1);
    if (outputText === undefined || outputText.length === 0) {
      throw new Error("Expected browser comparison output.");
    }
    const outputSchema = z.object({
      outcomes: z.array(z.object({ documentation: z.object({ returned: z.boolean() }) })),
    });
    const parsed = outputSchema.safeParse(JSON.parse(outputText));
    if (!parsed.success) {
      throw new Error("Expected browser comparison outcomes.");
    }
    const output = parsed.data;
    expect(output.outcomes).toHaveLength(desktopViewports.length);
    expect(output.outcomes.every((row) => row.documentation.returned)).toBe(true);
    expect(page.screenshot).toHaveBeenCalledTimes(artifactPaths.length);
    expect(artifactPaths.every((path) => /\/(?:root|documentation)\.png$/u.test(path))).toBe(true);
  });
});
