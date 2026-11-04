import { expect, it } from "vitest";
import { z } from "zod";
import {
  browserTestSelectionSchema,
  browserTestSelectionArguments,
} from "./browser-test-selection";

it("exports a portable model tool schema while rejecting every Unicode control character", () => {
  const exported = z.toJSONSchema(browserTestSelectionSchema);
  const parsed = z
    .object({ properties: z.object({ testName: z.object({ pattern: z.string() }) }) })
    .parse(exported);
  // JSON Schema transports no JavaScript RegExp flags. Validate exactly that syntax.
  // oxlint-disable-next-line eslint/require-unicode-regexp -- Match the flag-free RegExp syntax the JSON Schema consumer receives.
  const portable = new RegExp(parsed.properties.testName.pattern);
  for (const code of [
    ...Array.from({ length: 32 }, (_, index) => index),
    ...Array.from({ length: 33 }, (_, index) => index + 127),
  ]) {
    const testName = `Supplier${String.fromCodePoint(code)}paid`;
    expect(portable.test(testName)).toBe(false);
    expect(browserTestSelectionSchema.safeParse({ testName }).success).toBe(false);
  }
  const testName = "Supplier create/update (finance) ✓";
  expect(portable.test(testName)).toBe(true);
  expect(browserTestSelectionSchema.parse({ testName }).testName).toBe(testName);
});
it("keeps the selected test title literal instead of turning it into Playwright regex syntax", () => {
  const title = "Supplier [draft] (finance)+";
  const args = browserTestSelectionArguments({ testName: title });
  const filter = new RegExp(args[1], "u");
  expect(filter.test(title)).toBe(true);
  expect(filter.test("Supplier d financeee")).toBe(false);
});
