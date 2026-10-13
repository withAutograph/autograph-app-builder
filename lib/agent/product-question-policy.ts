import { z } from "zod";

/** Source bookkeeping is Builder work, rather than a product decision. */
export const isRepositoryRecoveryQuestion = (question: string): boolean => {
  const repositoryContext =
    /\b(?:github|git|repository|checkout|worktree|branch|pull request|pr)\b/iu;
  const recoveryContext =
    /\b(?:checkout|worktree)\b|\b(?:requested|selected|saved|exact|historical|mismatched)\b.{0,100}\b(?:baseline|commit|revision|ref)\b|\b[a-f0-9]{40}(?:[a-f0-9]{24})?\b/iu;
  const asksForLookup =
    /\b(?:which|what|where|provide|supply|tell|identify|find|choose|select)\b[\s\S]*\b(?:branch|pull request|pr|baseline|commit|sha|ref)\b/iu;
  return (
    repositoryContext.test(question) &&
    recoveryContext.test(question) &&
    asksForLookup.test(question)
  );
};

export const repositoryQuestionRecovery =
  "Handle source lookup and checkout recovery inside Builder. Inspect the saved source and app-baseline selection through source_status or resolve_github_source. The shared platform branch and historical app commit are separate selections; differing commits do not mean the checkout is wrong. Repair the actual source operation without asking the user for branches, PRs or Git references. This validation error is not a user answer or approval.";

/** Synthetic verification topology follows accepted permissions, not a new product decision. */
export const isSyntheticVerificationFixtureQuestion = (question: string): boolean => {
  const fixtureActors =
    /\b(?:(?<scope>real|actual|staff|production|live|invited)\s+(?:(?:hosted|invited|employee)\s+){0,2})?(?:synthetic|test|testing|verification|fixture|qa|e2e)[\s-]+(?:(?:actor|user|account|fixture)[\s-]+)?(?:actors?|profiles?|identities|personas?|users?|accounts?|memberships?)\b/giu;
  const hasFixtureActors = [...question.matchAll(fixtureActors)].some(
    (match) => match.groups?.scope === undefined,
  );
  const permissionTopology =
    /\b(?:tenants?|roles?|memberships?|assignments?|mapping|layout|matrix|topology|belong)\b/iu;
  const asksForLayout =
    /\b(?:which|what|how|where|choose|select|define|design|assign|map|distribute|specify|provide|confirm|should|want|tell)\b/iu;
  return [hasFixtureActors, permissionTopology.test(question), asksForLayout.test(question)].every(
    Boolean,
  );
};

export const syntheticFixtureQuestionRecovery =
  "Design synthetic verification actors and tenant/role fixtures inside Builder from accepted permissions and required behavioral coverage. An empty app-role set means no app assignment. Preserve the real owner's existing tenant and membership; fixture planning grants no real access. Actual new accounts, memberships, resources or permissions require specific effect review. Repair the fixture plan and continue; this validation error is not a user answer or approval.";

/** Preserve the native question shape and limits; validate before its durable human request. */
export const productQuestionInputSchema = z
  .strictObject({
    options: z
      .array(
        z.strictObject({
          description: z.string().min(1).max(200),
          label: z.string().min(1).max(80),
        }),
      )
      .min(2)
      .max(3)
      .optional(),
    question: z.string().min(1).max(2000),
  })
  .superRefine((input, context) => {
    if (
      input.options !== undefined &&
      new Set(input.options.map(({ label }) => label)).size !== input.options.length
    ) {
      context.addIssue({
        code: "custom",
        message: "Option labels must be unique.",
        path: ["options"],
      });
    }
    if (isRepositoryRecoveryQuestion(input.question)) {
      context.addIssue({ code: "custom", message: repositoryQuestionRecovery, path: ["question"] });
    }
    if (isSyntheticVerificationFixtureQuestion(input.question)) {
      context.addIssue({
        code: "custom",
        message: syntheticFixtureQuestionRecovery,
        path: ["question"],
      });
    }
  });
