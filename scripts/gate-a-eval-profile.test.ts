import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createGateAEvalProfile,
  gateAEnvironmentFields,
  installGateAEvalProfile,
  validateGateAEvalProfile,
} from "./gate-a-eval-profile.mjs";
import { gateAEvalWorkflowBodyTimeout } from "./run-with-test-capability.mts";

const repositoryRoot = resolve(import.meta.dirname, "..");

function hostileEnvironment(): Record<string, string | undefined> {
  return Object.fromEntries(
    gateAEnvironmentFields.map((field) => [field, `hostile-${field}`]),
  );
}

function freshRoots() {
  const owner = realpathSync(
    mkdtempSync(join(tmpdir(), "gate-a-eval-profile-")),
  );
  const stateRoot = join(owner, "state");
  const allowedRoot = join(owner, "destinations");
  mkdirSync(stateRoot, { mode: 0o700 });
  mkdirSync(allowedRoot, { mode: 0o700 });
  return { owner, stateRoot, allowedRoot };
}

describe("closed Gate A eval profile", () => {
  it.each([
    ["1", "1"],
    ["0", "0"],
  ])("installs only the general %s profile", (localPublication, expected) => {
    const profile = createGateAEvalProfile(
      { profile: "general", localPublication },
      repositoryRoot,
    );
    const environment = hostileEnvironment();
    installGateAEvalProfile(environment, profile, repositoryRoot);
    expect(environment.APP_BUILDER_LOCAL_PUBLICATION).toBe(expected);
    expect(environment.APP_BUILDER_BRANCH_WORKTREE_PUBLICATION).toBe("1");
    expect(environment.APP_BUILDER_BRANCH_WORKTREE_ROOT).toBeUndefined();
    expect(environment.APP_BUILDER_SANDBOX_IMAGE).toBeUndefined();
    expect(Object.keys(environment).sort()).toEqual([
      "APP_BUILDER_BRANCH_WORKTREE_PUBLICATION",
      "APP_BUILDER_LOCAL_PUBLICATION",
    ]);
  });

  it("binds and reobserves fresh roots and the recovery fault", () => {
    const roots = freshRoots();
    const profile = createGateAEvalProfile(
      {
        profile: "fresh",
        stateRoot: roots.stateRoot,
        allowedRoot: roots.allowedRoot,
        fault: "after-stage",
      },
      repositoryRoot,
    );
    expect(validateGateAEvalProfile(profile, repositoryRoot)).toEqual(profile);
    const environment = hostileEnvironment();
    installGateAEvalProfile(environment, profile, repositoryRoot);
    expect(environment).toEqual({
      APP_BUILDER_LOCAL_PUBLICATION: "1",
      APP_BUILDER_BRANCH_WORKTREE_PUBLICATION: "1",
      APP_BUILDER_FRESH_BOOTSTRAP_ENABLED: "1",
      APP_BUILDER_FRESH_BOOTSTRAP_STATE_ROOT: roots.stateRoot,
      APP_BUILDER_FRESH_BOOTSTRAP_ALLOWED_ROOT: roots.allowedRoot,
      APP_BUILDER_FRESH_BOOTSTRAP_EVAL_FAULT: "after-stage",
    });
  });

  it("installs an unconfigured sandbox with the image truly absent", () => {
    const profile = createGateAEvalProfile(
      { profile: "sandbox", image: null, sourceRoot: null },
      repositoryRoot,
    );
    const environment = hostileEnvironment();
    installGateAEvalProfile(environment, profile, repositoryRoot);
    expect(environment).toEqual({
      APP_BUILDER_REAL_SANDBOX: "1",
      WORKFLOW_LOCAL_BODY_TIMEOUT_MS: "360000",
    });
    expect(environment.APP_BUILDER_SANDBOX_IMAGE).toBeUndefined();
    expect(gateAEvalWorkflowBodyTimeout(profile)).toBe("360000");
  });

  it("projects the body timeout only from a closed sandbox launch profile", () => {
    const sandbox = createGateAEvalProfile(
      { profile: "sandbox", image: null, sourceRoot: null },
      repositoryRoot,
    );
    const general = createGateAEvalProfile(
      { profile: "general", localPublication: "0" },
      repositoryRoot,
    );
    expect(gateAEvalWorkflowBodyTimeout(sandbox)).toBe("360000");
    expect(gateAEvalWorkflowBodyTimeout(general)).toBeUndefined();
    expect(
      gateAEvalWorkflowBodyTimeout({
        version: 1,
        profile: "sandbox",
        image: null,
        sourceRoot: null,
      }),
    ).toBeUndefined();
  });

  it("accepts only an explicit immutable sandbox image", () => {
    const image = `ghcr.io/example/toolchain@sha256:${"a".repeat(64)}`;
    const environment: Record<string, string | undefined> = {};
    installGateAEvalProfile(
      environment,
      createGateAEvalProfile(
        { profile: "sandbox", image, sourceRoot: null },
        repositoryRoot,
      ),
      repositoryRoot,
    );
    expect(environment.APP_BUILDER_SANDBOX_IMAGE).toBe(image);
    for (const hostile of [
      "",
      "ghcr.io/example/toolchain:latest",
      "@sha256:nope",
      `user:secret@ghcr.io/example/toolchain@sha256:${"a".repeat(64)}`,
    ])
      expect(() =>
        createGateAEvalProfile(
          { profile: "sandbox", image: hostile, sourceRoot: null },
          repositoryRoot,
        ),
      ).toThrow(/sandbox image/u);
  });

  it("installs the hosted artifact marker only from its closed sandbox profile", () => {
    const roots = freshRoots();
    const image = `ghcr.io/example/toolchain@sha256:${"c".repeat(64)}`;
    const profile = createGateAEvalProfile(
      {
        profile: "hosted-artifact",
        image,
        sourceRoot: roots.allowedRoot,
      },
      repositoryRoot,
    );
    const environment = hostileEnvironment();
    installGateAEvalProfile(environment, profile, repositoryRoot);
    expect(environment).toEqual({
      APP_BUILDER_REAL_SANDBOX: "1",
      APP_BUILDER_HOSTED_ARTIFACT_PROOF: "1",
      APP_BUILDER_SANDBOX_IMAGE: image,
      REPOSITORY_LOCAL_ROOTS: roots.allowedRoot,
      WORKFLOW_LOCAL_BODY_TIMEOUT_MS: "360000",
    });
    expect(validateGateAEvalProfile(profile, repositoryRoot)).toEqual(profile);

    const ordinaryEnvironment = hostileEnvironment();
    installGateAEvalProfile(
      ordinaryEnvironment,
      createGateAEvalProfile(
        { profile: "sandbox", image, sourceRoot: roots.allowedRoot },
        repositoryRoot,
      ),
      repositoryRoot,
    );
    expect(
      ordinaryEnvironment.APP_BUILDER_HOSTED_ARTIFACT_PROOF,
    ).toBeUndefined();
  });

  it("binds and reobserves an explicit read-only sandbox source root", () => {
    const roots = freshRoots();
    const image = `ghcr.io/example/toolchain@sha256:${"b".repeat(64)}`;
    const profile = createGateAEvalProfile(
      { profile: "sandbox", image, sourceRoot: roots.allowedRoot },
      repositoryRoot,
    );
    const environment = hostileEnvironment();
    installGateAEvalProfile(environment, profile, repositoryRoot);
    expect(environment).toEqual({
      APP_BUILDER_REAL_SANDBOX: "1",
      APP_BUILDER_SANDBOX_IMAGE: image,
      REPOSITORY_LOCAL_ROOTS: roots.allowedRoot,
      WORKFLOW_LOCAL_BODY_TIMEOUT_MS: "360000",
    });
    if (profile?.profile !== "sandbox")
      throw new Error("Expected sandbox profile.");
    expect(() =>
      validateGateAEvalProfile(
        {
          ...profile,
          sourceRoot: { ...profile.sourceRoot, inode: "0" },
        },
        repositoryRoot,
      ),
    ).toThrow(/source root identity/u);
    expect(() =>
      validateGateAEvalProfile(
        { ...profile, image: "ghcr.io/example/toolchain:latest" },
        repositoryRoot,
      ),
    ).toThrow(/sandbox image/u);
  });

  it("rejects cross-profile keys, invalid faults, and root identity drift", () => {
    expect(() =>
      validateGateAEvalProfile(
        {
          version: 1,
          profile: "general",
          localPublication: "1",
          image: null,
        },
        repositoryRoot,
      ),
    ).toThrow(/profile envelope/u);
    const roots = freshRoots();
    expect(() =>
      createGateAEvalProfile(
        {
          profile: "fresh",
          stateRoot: roots.stateRoot,
          allowedRoot: roots.allowedRoot,
          fault: "before-write",
        },
        repositoryRoot,
      ),
    ).toThrow(/fresh fault/u);
    const profile = createGateAEvalProfile(
      {
        profile: "fresh",
        stateRoot: roots.stateRoot,
        allowedRoot: roots.allowedRoot,
        fault: null,
      },
      repositoryRoot,
    );
    if (profile?.profile !== "fresh")
      throw new Error("Expected fresh profile.");
    expect(() =>
      validateGateAEvalProfile(
        {
          ...profile,
          stateRoot: { ...profile.stateRoot, inode: "0" },
        },
        repositoryRoot,
      ),
    ).toThrow(/root identity/u);
  });

  it("rejects symlink roots without disclosing hostile values", () => {
    const roots = freshRoots();
    const linked = join(roots.owner, "linked");
    symlinkSync(roots.stateRoot, linked);
    let message = "";
    try {
      createGateAEvalProfile(
        {
          profile: "fresh",
          stateRoot: linked,
          allowedRoot: roots.allowedRoot,
          fault: null,
        },
        repositoryRoot,
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe("The trusted Gate A eval root was invalid.");
    expect(message).not.toContain(linked);
    const missing = join(roots.owner, "do-not-disclose-missing-root");
    try {
      createGateAEvalProfile(
        {
          profile: "fresh",
          stateRoot: missing,
          allowedRoot: roots.allowedRoot,
          fault: null,
        },
        repositoryRoot,
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe("The trusted Gate A eval root was invalid.");
    expect(message).not.toContain(missing);
  });
});
