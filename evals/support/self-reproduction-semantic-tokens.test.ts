import { chromium } from "playwright";
import { parse } from "postcss";
import { expect, it } from "vitest";
import {
  semanticTokenProbeBinding,
  canonicalTokenStylesheet,
  inspectSemanticColors,
} from "./self-reproduction-semantic-tokens";

const canonical =
  '@import "tailwindcss"; @theme { --color-blue: #8192ff; --color-action-primary: var(--color-blue); } .dark { --color-action-primary: #292929; }';

it("refuses unresolved imports rather than inventing canonical token values", () => {
  expect(() => canonicalTokenStylesheet('@import "./missing.css";', parse)).toThrow(
    "unresolved import",
  );
});

it.runIf(process.env.SELF_REPRODUCTION_BROWSER_TESTS === "1")(
  "normalizes real browser colors, detects overrides, and preserves unmapped uncertainty",
  async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      const css = canonicalTokenStylesheet(canonical, parse);
      await page.setContent(
        "<html><body><button>Submit</button><label>Unmapped</label></body></html>",
      );
      await page.addStyleTag({
        content: `${css} button { background-color: var(--color-action-primary); }`,
      });
      const normal = await inspectSemanticColors(page, browser, css);
      expect(normal.samples).toContainEqual(
        expect.objectContaining({
          token: "--color-action-primary",
          actual: "rgb(129, 146, 255)",
          expected: "rgb(129, 146, 255)",
          status: "passed",
        }),
      );
      expect(normal.samples.some((sample) => sample.status === "unassessed")).toBe(true);
      await page.addStyleTag({ content: "button { background-color: rgb(255, 0, 0); }" });
      const override = await inspectSemanticColors(page, browser, css);
      expect(override.status).toBe("failed");
      expect(override.samples).toContainEqual(
        expect.objectContaining({
          actual: "rgb(255, 0, 0)",
          expected: "rgb(129, 146, 255)",
          status: "failed",
        }),
      );
      await page.setContent('<html class="dark"><body><button>Submit</button></body></html>');
      await page.addStyleTag({
        content: `${css} button { background-color: var(--color-action-primary); }`,
      });
      const dark = await inspectSemanticColors(page, browser, css);
      expect(dark.samples).toContainEqual(
        expect.objectContaining({
          actual: "rgb(41, 41, 41)",
          expected: "rgb(41, 41, 41)",
          status: "passed",
        }),
      );
    } finally {
      await browser.close();
    }
  },
);

it("binds only actual archived canonical and candidate stylesheet paths", () => {
  const input = {
    runtimeRoot: "/actual/runtime",
    candidateAppId: "replica",
    candidateFiles: [{ path: "app/globals.css" }],
    workspacePaths: ["packages/design-systems/core/tokens/theme.css"],
  };
  expect(semanticTokenProbeBinding(input)).toEqual({
    canonicalThemePath: "/actual/runtime/packages/design-systems/core/tokens/theme.css",
    candidateStylesheetPaths: ["/actual/runtime/apps/replica/app/globals.css"],
  });
  expect(semanticTokenProbeBinding({ ...input, workspacePaths: [] })).toBeUndefined();
  expect(semanticTokenProbeBinding({ ...input, candidateFiles: [] })).toBeUndefined();
});
