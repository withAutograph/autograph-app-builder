import { describe, expect, it } from "vitest";

import { hasCanonicalFetchRemote } from "./portable-release";

const repository = "https://github.com/withAutograph/autograph-app-builder";

describe("canonical portable-release remotes", () => {
  it.each([repository, `${repository}.git`])(
    "accepts the exact HTTPS fetch remote: %s",
    (remote) => {
      expect(
        hasCanonicalFetchRemote(`origin\t${remote} (fetch)`, repository),
      ).toBe(true);
    },
  );

  it("accepts the exact canonical fetch remote in a blobless partial clone", () => {
    expect(
      hasCanonicalFetchRemote(
        `origin\t${repository}.git (fetch) [blob:none]`,
        repository,
      ),
    ).toBe(true);
  });

  it.each([
    `origin\t${repository.replace("withAutograph", "other-owner")} (fetch)`,
    `origin\t${repository} (push)`,
    `origin\tgit@github.com:withAutograph/autograph-app-builder.git (fetch)`,
    `origin\thttps://github.com/withAutograph/autograph-app-builder.git.git (fetch)`,
    `origin\thttps://user:pass@github.com/withAutograph/autograph-app-builder (fetch)`,
    `origin\thttps://github.com/withAutograph/autograph-app-builder-extra (fetch)`,
    `origin\thttps://github.com/withAutograph/autograph-app-builder.git (push)`,
    `origin\t${repository}.git (fetch) [tree:0]`,
    `origin\t${repository}.git (fetch) [blob:none] extra`,
  ])("rejects an out-of-contract remote: %s", (remote) => {
    expect(hasCanonicalFetchRemote(remote, repository)).toBe(false);
  });

  it("does not accept malformed remote lines or non-HTTPS authorities", () => {
    expect(
      hasCanonicalFetchRemote(
        "origin https://github.com/withAutograph/autograph-app-builder",
        repository,
      ),
    ).toBe(false);
    expect(
      hasCanonicalFetchRemote(
        "origin\thttps://github.com/withAutograph/autograph-app-builder/ (fetch)",
        repository,
      ),
    ).toBe(false);
  });
});
