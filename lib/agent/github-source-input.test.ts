import { expect, it } from "vitest";
import { z } from "zod";

import {
  assertSelectedSourceBranch,
  inputSchema as githubSourceInputSchema,
} from "../../agent/tools/resolve_github_source";
import { inputSchema as repositoryAccessInputSchema } from "../../agent/tools/resolve_repository_access";

// eslint-disable-next-line eslint/func-style -- A shared assertion verifies both hosted source tools.
function assertAutomaticInstallationSelection(schema: z.ZodType) {
  const jsonSchema = z.toJSONSchema(schema, { io: "input", target: "draft-07" });
  expect(jsonSchema.required).toEqual(["repository", "selectedInstallationId"]);
  const automatic = schema.parse({
    repository: "withAutograph/arrusted-development",
    selectedInstallationId: null,
  });
  expect(JSON.stringify(automatic)).toBe('{"repository":"withAutograph/arrusted-development"}');
  expect(
    schema.parse({
      repository: "withAutograph/arrusted-development",
      selectedInstallationId: "157775973",
    }),
  ).toEqual({
    repository: "withAutograph/arrusted-development",
    selectedInstallationId: "157775973",
  });
}

it("allows automatic selection for an existing source", () => {
  assertAutomaticInstallationSelection(githubSourceInputSchema);
});

it("allows automatic selection for repository access", () => {
  assertAutomaticInstallationSelection(repositoryAccessInputSchema);
});

it("accepts an initial branch or open PR and rejects conflicting source selectors", () => {
  const repository = {
    repository: "withAutograph/arrusted-development",
    selectedInstallationId: null,
  };
  expect(
    githubSourceInputSchema.parse({ ...repository, branch: "codex/app-production-pilot" }),
  ).toMatchObject({ branch: "codex/app-production-pilot" });
  expect(githubSourceInputSchema.parse({ ...repository, pullRequestNumber: 1514 })).toMatchObject({
    pullRequestNumber: 1514,
  });
  expect(
    githubSourceInputSchema.safeParse({ ...repository, branch: "main", pullRequestNumber: 1514 })
      .success,
  ).toBe(false);
  expect(
    githubSourceInputSchema.safeParse({
      ...repository,
      draftPullRequestNumber: 1500,
      pullRequestNumber: 1514,
    }).success,
  ).toBe(false);
  for (const branch of ["../main", "main.lock", "-main", "main\nother", ".private/main"]) {
    expect(githubSourceInputSchema.safeParse({ ...repository, branch }).success).toBe(false);
  }
});

it("selects historical app input independently of the current platform branch", () => {
  const input = {
    appBaseline: { appId: "spend-review", source: { kind: "merged-pr", pullRequestNumber: 1500 } },
    branch: "codex/builder-complete-app-runtime",
    repository: "withAutograph/arrusted-development",
    selectedInstallationId: null,
  };
  expect(githubSourceInputSchema.parse(input)).toMatchObject({
    appBaseline: input.appBaseline,
    branch: input.branch,
  });
  expect(
    githubSourceInputSchema.safeParse({
      ...input,
      appBaseline: { ...input.appBaseline, source: { commitSha: "main", kind: "commit" } },
    }).success,
  ).toBe(false);
});

it("keeps an occupied source on its branch and directs a different selection to a fresh session", () => {
  expect(() => {
    assertSelectedSourceBranch({
      requestedBranch: "codex/app-production-pilot",
      resolvedRef: "refs/heads/codex/app-production-pilot",
    });
  }).not.toThrow();
  expect(() => {
    assertSelectedSourceBranch({
      // An omitted branch retains the saved source.
      // oxlint-disable-next-line sonarjs/no-undefined-assignment -- Model the omitted optional selector.
      requestedBranch: undefined,
      resolvedRef: "refs/heads/codex/app-production-pilot",
    });
  }).not.toThrow();
  expect(() => {
    assertSelectedSourceBranch({
      requestedBranch: "codex/app-production-pilot",
      resolvedRef: "refs/heads/main",
    });
  }).toThrow("occupied checkout will not be replaced");
});
