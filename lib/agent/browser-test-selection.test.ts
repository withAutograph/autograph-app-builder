import { describe, expect, it } from "vitest";
import { z } from "zod";
import { asSchema } from "ai";
// oxlint-disable-next-line sonarjs/no-internal-api-use -- Regression exercises the installed Eve serializer that emits model function schemas.
import { toInputSchema, toModelSchema } from "../../node_modules/eve/dist/src/tools/schema.js";
import plan from "../../agent/tools/plan-app-hosted-runtime";
import {
  browserTestSelectionArguments,
  browserTestSelectionSchema,
} from "./browser-test-selection";

const plannerInput = { appId: "orchard", environment: "preview", operation: "continuity" };

describe("literal browser selection model transport", () => {
  it("keeps regex punctuation literal and preserves execution controls", () => {
    const selection = { testName: "literal [item].*", workers: 2, retries: 0, maxFailures: 1 };
    const args = browserTestSelectionArguments(selection);
    expect(args).toEqual([
      "--grep",
      "literal \\[item\\]\\.\\*",
      "--workers=2",
      "--retries=0",
      "--max-failures=1",
    ]);
    expect(new RegExp(z.string().parse(args[1]), "u").test(selection.testName)).toBe(true);
    expect(new RegExp(z.string().parse(args[1]), "u").test("literal anything")).toBe(false);
  });
  it.each(["\u0000", "\n", "\r", "\t", "\u007F", "\u0085", "\u009F"])(
    "rejects Cc control %j at the runtime boundary",
    (control) => {
      expect(
        browserTestSelectionSchema.safeParse({ testName: `before${control}after` }).success,
      ).toBe(false);
    },
  );
  it.each(["@acceptance", "租户😀 [QA]", "literal $() ; 'quoted'", "x".repeat(160)])(
    "accepts valid literal title %s",
    (testName) => {
      expect(browserTestSelectionSchema.parse({ testName }).testName).toBe(testName);
    },
  );
  it("emits a provider-compatible planner title schema while retaining model-input control validation", async () => {
    const lowered = asSchema(toModelSchema(toInputSchema(plan.inputSchema), "input"));
    const title = z
      .object({
        properties: z.object({
          browserSelection: z.object({
            properties: z.object({
              testName: z.object({
                type: z.literal("string"),
                minLength: z.number(),
                maxLength: z.number(),
                pattern: z.string().optional(),
              }),
            }),
          }),
        }),
      })
      .parse(lowered.jsonSchema).properties.browserSelection.properties.testName;
    // The provider receives no Unicode-property regex whose flags are lost in JSON Schema.
    expect(title.pattern).toBeUndefined();
    expect(title.minLength).toBe(1);
    expect(title.maxLength).toBe(160);
    if (lowered.validate === undefined) {
      throw new Error("Missing installed model validator");
    }
    expect(
      await lowered.validate({ ...plannerInput, browserSelection: { testName: "@acceptance" } }),
    ).toMatchObject({ success: true });
    expect(
      await lowered.validate({
        ...plannerInput,
        browserSelection: { testName: "before\u0085after" },
      }),
    ).toMatchObject({ success: false });
    expect(
      await lowered.validate({ ...plannerInput, browserSelection: { testName: "" } }),
    ).toMatchObject({ success: false });
    expect(
      await lowered.validate({
        ...plannerInput,
        browserSelection: { testName: "@acceptance", workers: 0 },
      }),
    ).toMatchObject({ success: false });
  });
});
