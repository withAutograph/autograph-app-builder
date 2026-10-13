import { describe, expect, it } from "vitest";
import { askQuestion } from "eve/tools/ask_question";

import {
  isRepositoryRecoveryQuestion,
  productQuestionInputSchema,
  repositoryQuestionRecovery,
} from "./product-question-policy";
import question from "../../agent/tools/ask_question";

describe("Builder product-question policy", () => {
  it.each([
    `The selected checkout is still at main, not the requested baseline ${"a".repeat(40)}. Which named branch or open PR in example/repository contains that exact baseline?`,
    "Which branch contains the saved historical app commit in the selected GitHub repository?",
    "Can you provide the Git ref for the mismatched checkout?",
  ])("rejects source-recovery input before the native human request: %s", async (text) => {
    expect(isRepositoryRecoveryQuestion(text)).toBe(true);
    const validation = await productQuestionInputSchema["~standard"].validate({ question: text });
    expect(validation).toHaveProperty("issues");
    expect(() => productQuestionInputSchema.parse({ question: text })).toThrow(
      repositoryQuestionRecovery,
    );
  });

  it.each([
    "Should requesters also review other people's requests?",
    "How long should requests be retained?",
    "Which connected GitHub account should store this app?",
    "Which branch should the review app monitor by default?",
    "Which historical version should app users compare in the dashboard?",
  ])("preserves material product and account choices: %s", (text) => {
    expect(isRepositoryRecoveryQuestion(text)).toBe(false);
    const input = { question: text };
    expect(productQuestionInputSchema.parse(input)).toEqual(input);
  });

  it("retains the native durable executor and answer/dismissal/unavailable output schema", () => {
    const native = askQuestion();
    expect(question.execute).toBe(native.execute);
    expect(question.outputSchema).toBe(native.outputSchema);
    expect(question.inputSchema).toBe(productQuestionInputSchema);
  });

  it("preserves ordinary options and the native duplicate-label restriction", () => {
    const input = {
      options: [
        { description: "Allow both roles with self-review denied.", label: "Both (Recommended)" },
        { description: "Allow only submitting requests.", label: "Requester" },
      ],
      question: "Which app roles should the owner have?",
    };
    expect(productQuestionInputSchema.parse(input)).toEqual(input);
    expect(() =>
      productQuestionInputSchema.parse({ ...input, options: [input.options[0], input.options[0]] }),
    ).toThrow("Option labels must be unique.");
  });
});
