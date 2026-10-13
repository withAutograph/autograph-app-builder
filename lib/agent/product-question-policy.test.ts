import { describe, expect, it } from "vitest";
import { askQuestion } from "eve/tools/ask_question";

import {
  isRepositoryRecoveryQuestion,
  isSyntheticVerificationFixtureQuestion,
  productQuestionInputSchema,
  repositoryQuestionRecovery,
  syntheticFixtureQuestionRecovery,
} from "./product-question-policy";
import question from "../../agent/tools/ask_question";

describe("Builder product-question policy", () => {
  it.each([
    "The agreed behavior is clear, but I can’t find the exact membership layout for the eight test actors. To preserve it without inventing permissions, what tenant and roles should each actor have? Stable labels A–H are fine.",
    "How should we map synthetic actor profiles across tenants and roles for verification?",
    "Which tenant should each test account belong to, and what app roles should it have?",
    "Please define the verification personas and their membership matrix.",
    "What app-role assignments should the synthetic fixture memberships have?",
    "Preserve the real owner’s membership; which roles should each test actor have?",
  ])("keeps synthetic fixture design inside Builder before a human request: %s", async (text) => {
    expect(isSyntheticVerificationFixtureQuestion(text)).toBe(true);
    const validation = await productQuestionInputSchema["~standard"].validate({ question: text });
    expect(validation).toHaveProperty("issues");
    expect(() => productQuestionInputSchema.parse({ question: text })).toThrow(
      syntheticFixtureQuestionRecovery,
    );
  });

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
    "Which role should the invited real user have in your existing tenant?",
    "Should an employee who requests purchases also review other employees’ requests?",
    "Which tenant represents the actual business department?",
    "Which workspace membership should the invited customer receive?",
    "Which roles should real invited users have for hosted verification?",
    "Which role should actual employee profiles have for verification?",
    "Which production user profiles should receive Reviewer membership during QA?",
    "Which roles should real verification actors have?",
    "Which staff profiles need access to the QA tenant?",
    "Which connected provider account should the app use?",
    "What does the Reviewer role mean for real staff?",
    "Which user profile fields should the product display?",
    "Should reviewers be able to test requests made by other people?",
  ])("preserves material product and account choices: %s", (text) => {
    expect(isRepositoryRecoveryQuestion(text)).toBe(false);
    expect(isSyntheticVerificationFixtureQuestion(text)).toBe(false);
    const input = { question: text };
    expect(productQuestionInputSchema.parse(input)).toEqual(input);
  });

  it("retains the native durable executor and answer/dismissal/unavailable output schema", () => {
    const native = askQuestion();
    expect(question.execute).toBe(native.execute);
    expect(question.outputSchema).toBe(native.outputSchema);
    expect(question.inputSchema).toBe(productQuestionInputSchema);
  });

  it("makes fixture repair recoverable without granting real access or inventing actor quotas", () => {
    expect(syntheticFixtureQuestionRecovery).toContain(
      "accepted permissions and required behavioral coverage",
    );
    expect(syntheticFixtureQuestionRecovery).toContain(
      "empty app-role set means no app assignment",
    );
    expect(syntheticFixtureQuestionRecovery).toContain(
      "Preserve the real owner's existing tenant and membership",
    );
    expect(syntheticFixtureQuestionRecovery).toContain("specific effect review");
    expect(syntheticFixtureQuestionRecovery).toContain("not a user answer or approval");
    expect(syntheticFixtureQuestionRecovery).not.toMatch(/eight|A–H|two tenants|four roles/iu);
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
