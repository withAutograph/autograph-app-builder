import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const inspectSourceReceipt = vi.hoisted(() => vi.fn());

vi.mock("./source-receipt", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./source-receipt")>()),
  inspectSourceReceipt,
}));

import { developmentFreshTemplateSourceReceipt } from "./development-source";

const roots: string[] = [];

afterEach(() => {
  inspectSourceReceipt.mockReset();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

function exactEnvironment(root: string) {
  return {
    APP_BUILDER_EXECUTION_MODE: "development",
    APP_BUILDER_EXECUTION_BUNDLE: "local-development",
    APP_BUILDER_SANDBOX_PROVIDER: "vercel",
    APP_BUILDER_LOCAL_ADAPTER: "1",
    APP_BUILDER_LOCAL_PUBLICATION: "0",
    APP_BUILDER_BRANCH_WORKTREE_PUBLICATION: "0",
    APP_BUILDER_GITHUB_PUBLICATION_ENABLED: "0",
    APP_BUILDER_FRESH_BOOTSTRAP_ENABLED: "0",
    APP_BUILDER_LOCAL_PROVIDER_EMULATION: "0",
    APP_BUILDER_LOCAL_AUTH_EMULATION: "0",
    APP_BUILDER_HOSTED_ARTIFACT_PROOF: "0",
    EVE_HOSTED_ADAPTER: "0",
    WORKFLOW_LOCAL_RECOVER_ACTIVE_RUNS: "0",
    APP_BUILDER_DEVELOPMENT_SOURCE_SHA: "a".repeat(40),
    APP_BUILDER_DEVELOPMENT_SOURCE_TREE: "b".repeat(40),
    APP_BUILDER_DEVELOPMENT_SOURCE_FINGERPRINT: "c".repeat(64),
    REPOSITORY_LOCAL_ROOTS: root,
  } as const;
}

function fixtureRoot() {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "app-builder-development-source-")),
  );
  roots.push(root);
  return root;
}

function receipt(root: string) {
  return {
    version: 3 as const,
    sourceKind: "fresh-template" as const,
    sourcePath: root,
    sourceSha: "a".repeat(40),
    sourceTree: "b".repeat(40),
    adapter: "arrusted-template-v0" as const,
    eligibilityDigest: "d".repeat(64),
    contractDigest: "e".repeat(64),
    releaseEnabled: false as const,
    digest: "f".repeat(64),
  };
}

describe("Development fresh-template source selection", () => {
  it("uses the exact transient local snapshot without a deployment reader", async () => {
    const root = fixtureRoot();
    const expected = receipt(root);
    inspectSourceReceipt.mockResolvedValue(expected);

    await expect(
      developmentFreshTemplateSourceReceipt(exactEnvironment(root)),
    ).resolves.toEqual(expected);
    expect(inspectSourceReceipt).toHaveBeenCalledWith("fresh-template", root);
  });

  it("never selects a local path in a hosted Vercel runtime", async () => {
    const root = fixtureRoot();
    await expect(
      developmentFreshTemplateSourceReceipt({
        ...exactEnvironment(root),
        VERCEL: "1",
      }),
    ).resolves.toBeUndefined();
    expect(inspectSourceReceipt).not.toHaveBeenCalled();
  });

  it("rejects a development binding that could publish", async () => {
    const root = fixtureRoot();
    await expect(
      developmentFreshTemplateSourceReceipt({
        ...exactEnvironment(root),
        APP_BUILDER_LOCAL_PUBLICATION: "1",
      }),
    ).rejects.toThrow("binding was not closed");
    expect(inspectSourceReceipt).not.toHaveBeenCalled();
  });

  it("rejects a source whose exact Git identity drifted", async () => {
    const root = fixtureRoot();
    inspectSourceReceipt.mockResolvedValue({
      ...receipt(root),
      sourceSha: "9".repeat(40),
    });
    await expect(
      developmentFreshTemplateSourceReceipt(exactEnvironment(root)),
    ).rejects.toThrow("snapshot drifted");
  });
});
