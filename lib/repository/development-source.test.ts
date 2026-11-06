import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { canAutoSelectDevelopmentSource, developmentSourceReceipt } from "./development-source";

const roots: string[] = [];
const gitExecutable = "/opt/homebrew/bin/git";

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true });
  }
});

function exactEnvironment(root: string) {
  return {
    APP_BUILDER_BRANCH_WORKTREE_PUBLICATION: "0",
    APP_BUILDER_DEVELOPMENT_SOURCE_FINGERPRINT: "c".repeat(64),
    APP_BUILDER_DEVELOPMENT_SOURCE_SHA: "a".repeat(40),
    APP_BUILDER_DEVELOPMENT_SOURCE_TREE: "b".repeat(40),
    APP_BUILDER_EXECUTION_BUNDLE: "local-development",
    APP_BUILDER_EXECUTION_MODE: "development",
    APP_BUILDER_FRESH_BOOTSTRAP_ENABLED: "0",
    APP_BUILDER_GITHUB_PUBLICATION_ENABLED: "0",
    APP_BUILDER_HOSTED_ARTIFACT_PROOF: "0",
    APP_BUILDER_LOCAL_ADAPTER: "1",
    APP_BUILDER_LOCAL_AUTH_EMULATION: "0",
    APP_BUILDER_LOCAL_PROVIDER_EMULATION: "0",
    APP_BUILDER_LOCAL_PUBLICATION: "0",
    APP_BUILDER_SANDBOX_PROVIDER: "vercel",
    EVE_HOSTED_ADAPTER: "0",
    REPOSITORY_LOCAL_ROOTS: root,
    WORKFLOW_LOCAL_RECOVER_ACTIVE_RUNS: "0",
  } as const;
}

function fixtureRoot() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "app-builder-development-source-")));
  roots.push(root);
  execFileSync(gitExecutable, ["init", "--quiet", root]);
  execFileSync(gitExecutable, ["-C", root, "config", "user.name", "Test"]);
  execFileSync(gitExecutable, ["-C", root, "config", "user.email", "test@example.com"]);
  writeFileSync(path.join(root, "source.txt"), "initial\n");
  execFileSync(gitExecutable, ["-C", root, "add", "source.txt"]);
  execFileSync(gitExecutable, ["-C", root, "commit", "--quiet", "-m", "initial"]);
  return root;
}

describe("Development source selection", () => {
  it.each(["fresh-template", "existing-repository"] as const)(
    "uses the exact transient local snapshot for %s without a deployment reader",
    async (sourceKind) => {
      const root = fixtureRoot();
      const result = await developmentSourceReceipt(sourceKind, undefined, exactEnvironment(root));
      expect(result).toMatchObject({
        sourceKind,
        sourcePath: root,
        version: 3,
      });
      await expect(
        developmentSourceReceipt(sourceKind, undefined, exactEnvironment(root)),
      ).resolves.toEqual(result);
    },
  );

  it("accepts only the exact preselected path when one is supplied", async () => {
    const root = fixtureRoot();
    await expect(
      developmentSourceReceipt("existing-repository", root, exactEnvironment(root)),
    ).resolves.toMatchObject({ sourceKind: "existing-repository", sourcePath: root });
    await expect(
      developmentSourceReceipt("existing-repository", `${root}-other`, exactEnvironment(root)),
    ).rejects.toThrow("did not match the selected snapshot");
  });

  it("never selects a local path in a hosted Vercel runtime", async () => {
    const root = fixtureRoot();
    await expect(
      developmentSourceReceipt("existing-repository", undefined, {
        ...exactEnvironment(root),
        VERCEL: "1",
      }),
    ).resolves.toBeUndefined();
    expect(
      canAutoSelectDevelopmentSource({
        ...exactEnvironment(root),
        VERCEL: "1",
      }),
    ).toBe(false);
  });

  it("leaves explicit existing-repository paths to non-development readers", async () => {
    const root = fixtureRoot();
    await expect(
      developmentSourceReceipt("existing-repository", root, {}),
    ).resolves.toBeUndefined();
    expect(canAutoSelectDevelopmentSource({})).toBe(false);
  });

  it("rejects a development binding that could publish", async () => {
    const root = fixtureRoot();
    await expect(
      developmentSourceReceipt("existing-repository", undefined, {
        ...exactEnvironment(root),
        APP_BUILDER_LOCAL_PUBLICATION: "1",
      }),
    ).rejects.toThrow("binding was not closed");
    expect(
      canAutoSelectDevelopmentSource({
        ...exactEnvironment(root),
        APP_BUILDER_LOCAL_PUBLICATION: "1",
      }),
    ).toBe(false);
  });

  it("re-observes a source whose Git identity changed during development", async () => {
    const root = fixtureRoot();
    const previous = await developmentSourceReceipt(
      "existing-repository",
      undefined,
      exactEnvironment(root),
    );
    writeFileSync(join(root, "source.txt"), "changed\n");
    execFileSync(gitExecutable, ["-C", root, "add", "source.txt"]);
    execFileSync(gitExecutable, ["-C", root, "commit", "--quiet", "-m", "changed"]);
    await expect(
      developmentSourceReceipt("existing-repository", undefined, exactEnvironment(root)),
    ).resolves.toMatchObject({ sourcePath: root });
    const current = await developmentSourceReceipt(
      "existing-repository",
      undefined,
      exactEnvironment(root),
    );
    expect(current?.sourceSha).not.toBe(previous?.sourceSha);
  });
});
