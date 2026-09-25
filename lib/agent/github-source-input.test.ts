import { expect, it } from "vitest";
import { z } from "zod";

import { inputSchema as githubSourceInputSchema } from "../../agent/tools/resolve_github_source";
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
