import { chromium } from "playwright";
import { parse } from "postcss";
import { expect, it } from "vitest";
import { redactCandidateEvidence } from "./self-reproduction-candidate-capabilities";
import { sanitizeEvidence } from "./self-reproduction-evidence";
import { runSandboxRuntimeComparison } from "./self-reproduction-runtime-comparison";
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
          cssVariable: "--color-action-primary",
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

it("retains CSS identifiers in sanitized receipts while redacting credentials", async () => {
  const output = {
    result: { samples: [{ cssVariable: "--color-action-primary" }] },
    token: "synthetic-credential",
    diagnostic: "synthetic-credential",
  };
  const comparison = await runSandboxRuntimeComparison({
    session: {
      writeTextFile: () => Promise.resolve(),
      run: () => Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }),
      readTextFile: () => Promise.resolve(JSON.stringify(output)),
      readBinaryFile: () => Promise.resolve(null),
    },
    script: "// trusted evaluator fixture",
    payload: {},
    abortSignal: new AbortController().signal,
  });
  const receipt = redactCandidateEvidence(comparison, ["synthetic-credential"]);
  const serialized = sanitizeEvidence(JSON.stringify(receipt));
  if (typeof serialized !== "string") throw new Error("Expected serialized receipt");
  const retained = JSON.parse(serialized);
  expect(retained.status).toBe("completed");
  expect(retained.output.result.samples[0].cssVariable).toBe("--color-action-primary");
  expect(retained.output.token).toBe("[REDACTED]");
  expect(retained.output.diagnostic).toBe("[REDACTED]");
  expect(serialized).not.toContain("synthetic-credential");
});
