/* oxlint-disable eslint/require-await -- Local Sandbox ports retain the production asynchronous interface. */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SandboxSession } from "eve/sandbox";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  planOriginalPublicationRepair,
  stageOriginalPublicationRepair,
  rebuildOriginalPublicationComposition,
} from "./owned-draft-composition";
import {
  prepareDraftReconciliation,
  inspectDraftReconciliation,
  nonAppIndexDigest,
} from "./sandbox-draft-reconciliation";
import { assertOwnedPublicationReconciliationOrigin } from "./github-draft-reconciliation";
import { GITHUB_PUBLICATION_VERSION } from "./github-publication";
import type {
  DraftPullRequestProposal,
  DraftPullRequestSuccessReceipt,
} from "./github-publication";

const temporary: string[] = [];
const appId = "request-log";
const repo = { owner: "fixture", name: "apps" };
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const jsonSchema = z.record(z.string(), z.json());
const parseObject = (bytes: string) => jsonSchema.parse(JSON.parse(bytes));
const text = (value: z.infer<ReturnType<typeof z.json>>) => `${JSON.stringify(value, null, 2)}\n`;
const bunBinary = process.env.BUN_BINARY;
const availableBun = bunBinary !== undefined && existsSync(bunBinary) ? bunBinary : undefined;
const git = (root: string, ...args: string[]) =>
  execFileSync(
    "/usr/bin/git",
    ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-C", root, ...args],
    {
      encoding: "utf-8",
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  ).trim();
const write = (root: string, relative: string, bytes: string) => {
  const target = path.join(root, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, bytes);
};
const commit = (root: string, message: string) => {
  git(root, "add", "--all");
  git(root, "commit", "-m", message);
  return git(root, "rev-parse", "HEAD");
};

const fixture = (
  options: {
    compositionChanged?: boolean;
    realBun?: boolean;
    literalAddition?: boolean;
    firstPublication?: boolean;
  } = {},
) => {
  const workspace = mkdtempSync(path.join(tmpdir(), "builder-owned-composition-"));
  temporary.push(workspace);
  const remote = path.join(workspace, "remote.git");
  const checkout = path.join(workspace, "repository");
  mkdirSync(remote);
  git(remote, "init", "--bare", "--initial-branch=main");
  execFileSync("/usr/bin/git", ["clone", remote, checkout], { stdio: "pipe" });
  git(checkout, "config", "user.name", "Fixture");
  git(checkout, "config", "user.email", "fixture@example.test");
  const basePackage = {
    private: true,
    workspaces: ["apps/*", "packages/*"],
    catalog: { existing: "workspace:*" },
    scripts: { check: "preserved-command" },
  };
  const baseRoutes = {
    applications: {
      existing: { packageName: "@fixture/existing", routes: ["/existing"], custom: "kept" },
    },
    retained: "current-root",
  };
  write(checkout, ".gitignore", "node_modules/\n");
  write(checkout, "package.json", text(basePackage));
  write(checkout, "microfrontends.json", text(baseRoutes));
  write(
    checkout,
    "bun.lock",
    text({ workspaces: { "apps/existing": { name: "@fixture/existing" } }, retained: "base-lock" }),
  );
  write(
    checkout,
    "apps/existing/package.json",
    text({ name: "@fixture/existing", dependencies: { existing: "catalog:" } }),
  );
  write(checkout, "apps/existing/app/page.tsx", "export default 'existing app';\n");
  write(checkout, "packages/existing/package.json", text({ name: "existing", version: "1.0.0" }));
  write(checkout, "packages/needed/package.json", text({ name: "needed", version: "1.0.0" }));
  write(checkout, "docs/shared.md", "original shared documentation\n");
  // Minimal test-owned acquired platform planner, with no imported generated app.
  write(
    checkout,
    "packages/platform-microfrontends/src/policy/config-registration.ts",
    `
import {createHash} from 'node:crypto';
export const planMicrofrontendRegistration=(bytes,input)=>{
 const value=JSON.parse(bytes);const entry={packageName:input.packageName,routes:input.routes};
 if(value.applications[input.projectName]===undefined)value.applications[input.projectName]=entry;
 const proposedBytes=JSON.stringify(value,null,2)+'\\n';
 const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
 return{oldDigest:hash(bytes),newDigest:hash(proposedBytes),proposedBytes,projectName:input.projectName,assetRoute:'/'+input.projectName+'/:path*'};
};\n`,
  );
  const runBun = (directory: string) => {
    if (availableBun === undefined) {
      throw new Error("The explicit local Bun fixture binary is unavailable");
    }
    execFileSync(availableBun, ["install", "--lockfile-only", "--ignore-scripts"], {
      cwd: directory,
      env: { ...process.env, BUN_INSTALL_CACHE_DIR: path.join(workspace, "bun-cache") },
      stdio: "pipe",
    });
  };
  if (options.realBun === true) {
    runBun(checkout);
  }
  const originalBase = commit(checkout, "current repository before app publication");
  git(checkout, "push", "origin", "main");
  const installationIdentityDigest = "1".repeat(64);
  const repositoryObservationDigest = "2".repeat(64);
  const reviewDigest = "3".repeat(64);
  const idempotencyKey = digest(
    JSON.stringify({ installationIdentityDigest, repositoryObservationDigest, reviewDigest }),
  );
  const headBranch = `app-builder/review-${idempotencyKey.slice(0, 20)}`;
  git(checkout, "switch", "-c", headBranch);
  write(
    checkout,
    `apps/${appId}/package.json`,
    text({
      name: `@autograph/${appId}`,
      dependencies:
        options.firstPublication === true
          ? { existing: "catalog:" }
          : { existing: "catalog:", needed: "catalog:" },
    }),
  );
  write(checkout, `apps/${appId}/app/page.tsx`, "export default 'accepted app implementation';\n");
  if (options.literalAddition === true) {
    write(checkout, ":(glob)docs/**", "an unwanted literal-path publication addition\n");
  }
  if (options.firstPublication === true) {
    write(
      checkout,
      "microfrontends.json",
      text({
        ...baseRoutes,
        applications: {
          ...baseRoutes.applications,
          [appId]: {
            packageName: `@autograph/${appId}`,
            routes: [`/${appId}`, `/${appId}/:path*`],
          },
        },
      }),
    );
    if (options.realBun === true) {
      const sibling = "apps/existing/package.json";
      const manifest = readFileSync(path.join(checkout, sibling), "utf-8");
      rmSync(path.join(checkout, sibling));
      runBun(checkout);
      write(checkout, sibling, manifest);
    } else {
      write(
        checkout,
        "bun.lock",
        text({
          workspaces: {
            "apps/existing": { name: "@fixture/existing" },
            [`apps/${appId}`]: { name: `@autograph/${appId}` },
          },
          retained: "base-lock",
        }),
      );
    }
  } else {
    // Intentionally different from the accepted app: content equality is not ownership proof.
    write(checkout, "app/page.tsx", "export default 'unintended root application';\n");
  }
  if (options.firstPublication !== true && options.compositionChanged !== false) {
    write(
      checkout,
      "package.json",
      text({
        ...basePackage,
        catalog: { existing: "old-existing", needed: "workspace:*", unused: "must-not-copy" },
      }),
    );
    write(
      checkout,
      "microfrontends.json",
      text({
        applications: {
          [appId]: {
            packageName: `@autograph/${appId}`,
            routes: [`/${appId}`, `/${appId}/:path*`],
          },
        },
      }),
    );
    write(
      checkout,
      "bun.lock",
      text({ workspaces: { [`apps/${appId}`]: { name: `@autograph/${appId}` } } }),
    );
  }
  const originalHead = commit(
    checkout,
    options.firstPublication === true
      ? "Builder published its reviewed app and registration"
      : "Builder published its reviewed app and accidental root additions",
  );
  git(checkout, "push", "origin", headBranch);
  const approvedPaths = git(
    checkout,
    "diff",
    "--no-renames",
    "--name-only",
    originalBase,
    originalHead,
  )
    .split("\n")
    .filter(Boolean)
    .toSorted();
  const unsigned: Omit<DraftPullRequestProposal, "digest"> = {
    version: GITHUB_PUBLICATION_VERSION,
    installationIdentityDigest,
    repositoryId: "100",
    owner: repo.owner,
    name: repo.name,
    visibility: "private",
    baseBranch: "main",
    baseSha: originalBase,
    baseTree: git(checkout, "rev-parse", `${originalBase}^{tree}`),
    repositoryObservationDigest,
    releaseGate: { name: "REPOSITORY_RELEASE_ENABLED", configured: false },
    reviewDigest,
    changeSetDigest: "4".repeat(64),
    changedContentDigest: "5".repeat(64),
    approvedPaths,
    branchName: headBranch,
    draft: true,
    title: "Add controlled app",
    idempotencyKey,
    intendedOutcome: "publish-reviewed-change-set-as-draft-pull-request",
  };
  const proposal = { ...unsigned, digest: digest(JSON.stringify(unsigned)) };
  const receipt: Omit<DraftPullRequestSuccessReceipt, "digest"> = {
    version: GITHUB_PUBLICATION_VERSION,
    kind: "draft-pull-request",
    status: "succeeded",
    proposalDigest: proposal.digest,
    idempotencyKey,
    approvedByCallId: "approved-fixture-publication",
    installationIdentityDigest,
    repositoryId: proposal.repositoryId,
    branchName: headBranch,
    branchSha: originalHead,
    branchTree: git(checkout, "rev-parse", `${originalHead}^{tree}`),
    pullRequestId: "900",
    pullRequestNumber: 42,
    draft: true,
    baseBranch: "main",
    baseSha: originalBase,
    changeSetDigest: proposal.changeSetDigest,
    changedContentDigest: proposal.changedContentDigest,
    normalizedChangedPaths: approvedPaths,
    releaseGateUnchanged: true,
    recoveredFromPending: false,
    providerReadBackDigest: "6".repeat(64),
  };
  const owned = { proposal, publication: { ...receipt, digest: digest(JSON.stringify(receipt)) } };
  assertOwnedPublicationReconciliationOrigin(owned);
  git(checkout, "switch", "main");
  const currentPackage =
    options.firstPublication === true
      ? basePackage
      : {
          ...basePackage,
          catalog: { ...basePackage.catalog, newOtherApp: "workspace:*" },
          retainedNewBaseField: true,
        };
  const currentRoutes =
    options.firstPublication === true
      ? baseRoutes
      : {
          ...baseRoutes,
          applications: {
            ...baseRoutes.applications,
            newer: { packageName: "@fixture/newer", routes: ["/newer"], custom: "new-base" },
          },
        };
  if (options.firstPublication === true) {
    write(checkout, "docs/shared.md", "newer shared documentation on main\n");
  } else {
    write(checkout, "package.json", text(currentPackage));
    write(checkout, "microfrontends.json", text(currentRoutes));
    write(checkout, "apps/newer/package.json", text({ name: "@fixture/newer" }));
    write(checkout, "apps/newer/app/page.tsx", "export default 'new base app';\n");
    write(checkout, "packages/existing/package.json", text({ name: "existing", version: "2.0.0" }));
    if (options.realBun === true) {
      runBun(checkout);
    } else {
      write(
        checkout,
        "bun.lock",
        text({
          workspaces: {
            "apps/existing": { name: "@fixture/existing" },
            "apps/newer": { name: "@fixture/newer" },
          },
          retained: "current-base-lock",
        }),
      );
    }
  }
  const currentBase = commit(checkout, "unrelated source advanced on main");
  git(checkout, "push", "origin", "main");
  const currentLock = readFileSync(path.join(checkout, "bun.lock"), "utf-8");
  git(checkout, "switch", headBranch);
  const commands: string[] = [];
  const writes: string[] = [];
  const lockSeeds: string[] = [];
  const sandbox = {
    id: "controlled-composition-fixture",
    async run(input: { command: string; workingDirectory?: string }) {
      commands.push(input.command);
      if (input.command.includes("'remote' 'get-url' 'origin'")) {
        return {
          exitCode: 0,
          stdout: `https://github.com/${repo.owner}/${repo.name}.git\n`,
          stderr: "",
        };
      }
      let { command } = input;
      if (command.startsWith("bun -e ")) {
        if (availableBun === undefined) {
          const proposed = text({
            ...currentRoutes,
            applications: {
              ...currentRoutes.applications,
              [appId]: {
                packageName: `@autograph/${appId}`,
                routes: [`/${appId}`, `/${appId}/:path*`],
              },
            },
          });
          return {
            exitCode: 0,
            stderr: "",
            stdout: JSON.stringify({
              oldDigest: digest(text(currentRoutes)),
              newDigest: digest(proposed),
              proposedBytes: proposed,
              projectName: appId,
              assetRoute: `/${appId}/:path*`,
            }),
          };
        }
        command = `'${availableBun}'${command.slice(3)}`;
      }
      if (command.includes("bun install --lockfile-only --ignore-scripts")) {
        const candidate = /^cd '(?<candidate>[^']+)'/u.exec(command)?.groups?.candidate;
        if (candidate === undefined) {
          throw new Error("Expected a controlled candidate working directory");
        }
        lockSeeds.push(readFileSync(path.join(candidate, "bun.lock"), "utf-8"));
        if (options.realBun === true && availableBun !== undefined) {
          command = command.replace("mise exec --no-deps -- bun", `'${availableBun}'`);
        } else {
          return { exitCode: 0, stderr: "", stdout: "controlled lock generator retained its seed" };
        }
      }
      const directory = input.workingDirectory === "/workspace/repository" ? checkout : workspace;
      const result = spawnSync("/bin/sh", ["-c", command], {
        cwd: directory,
        encoding: "utf-8",
        env: {
          ...process.env,
          PATH: `${path.dirname(process.execPath)}:${process.env.PATH ?? ""}`,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
          BUN_INSTALL_CACHE_DIR: path.join(workspace, "bun-cache"),
        },
      });
      return { exitCode: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
    },
    async writeTextFile(input: { path: string; content: string }) {
      writes.push(input.path);
      write(workspace, input.path, input.content);
    },
    async writeBinaryFile(input: { path: string; content: Uint8Array }) {
      const target = path.join(workspace, input.path);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, input.content);
    },
    async readTextFile(input: { path: string }) {
      return readFileSync(path.join(workspace, input.path), "utf-8");
    },
    async removePath(input: { path: string }) {
      rmSync(path.join(workspace, input.path), { force: true });
    },
  };
  // SAFETY: This local fake implements only filesystem/command ports consumed by the real repository helper.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- Controlled local Sandbox boundary.
  const session = sandbox as unknown as SandboxSession;
  const request = () => ({
    sandbox: session,
    checkout,
    appId,
    headSha: git(checkout, "rev-parse", "HEAD"),
    baseSha: currentBase,
    owned,
    repair: { discardAddedPaths: ["app/page.tsx"] },
  });
  return {
    workspace,
    checkout,
    session,
    currentBase,
    currentPackage,
    currentRoutes,
    currentLock,
    originalBase,
    originalHead,
    owned,
    headBranch,
    request,
    commands,
    writes,
    lockSeeds,
  };
};
afterEach(() => {
  for (const directory of temporary.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("owned original publication composition repair", () => {
  it("proves and removes an original bot addition even when it differs from the app implementation", async () => {
    const f = fixture();
    const plan = await planOriginalPublicationRepair(f.request());
    expect(plan.restorePaths).toContain("app/page.tsx");
    expect(f.writes).toEqual([]);
    expect(git(f.checkout, "status", "--porcelain")).toBe("");
    await stageOriginalPublicationRepair({
      sandbox: f.session,
      root: f.checkout,
      originalBase: f.originalBase,
      plan,
    });
    expect(existsSync(path.join(f.checkout, "app/page.tsx"))).toBe(false);
    expect(readFileSync(path.join(f.checkout, `apps/${appId}/app/page.tsx`), "utf-8")).toBe(
      "export default 'accepted app implementation';\n",
    );
    expect(git(f.checkout, "show", `${f.originalHead}:app/page.tsx`)).toContain("unintended root");
  });

  it("treats a proven metacharacter filename literally without restoring unrelated human files", async () => {
    const f = fixture({ literalAddition: true });
    const humanDocumentation = "newer human documentation must remain unchanged\n";
    write(f.checkout, "docs/shared.md", humanDocumentation);
    commit(f.checkout, "human updated unrelated documentation");
    const beforeBlob = git(f.checkout, "rev-parse", ":docs/shared.md");
    const literalPath = ":(glob)docs/**";
    const plan = await planOriginalPublicationRepair({
      ...f.request(),
      repair: { discardAddedPaths: [literalPath] },
    });
    expect(plan.restorePaths).toContain(literalPath);
    await stageOriginalPublicationRepair({
      sandbox: f.session,
      root: f.checkout,
      originalBase: f.originalBase,
      plan,
    });
    expect(readFileSync(path.join(f.checkout, "docs/shared.md"), "utf-8")).toBe(humanDocumentation);
    expect(git(f.checkout, "rev-parse", ":docs/shared.md")).toBe(beforeBlob);
    expect(existsSync(path.join(f.checkout, literalPath))).toBe(false);
    expect(readFileSync(path.join(f.checkout, `apps/${appId}/app/page.tsx`), "utf-8")).toBe(
      "export default 'accepted app implementation';\n",
    );
  });

  it.each(["../escape", "apps/existing/app/page.tsx", "docs/unowned.md", "package.json"])(
    "rejects an unsafe, cross-app or unowned cleanup path before writes (%s)",
    async (discard) => {
      const f = fixture();
      await expect(
        planOriginalPublicationRepair({ ...f.request(), repair: { discardAddedPaths: [discard] } }),
      ).rejects.toThrow();
      expect(f.writes).toEqual([]);
      expect(git(f.checkout, "status", "--porcelain")).toBe("");
      expect(git(f.checkout, "rev-parse", "HEAD")).toBe(f.originalHead);
    },
  );

  it.each(["content", "mode"] as const)(
    "retains human-modified cleanup candidates without writes (%s)",
    async (kind) => {
      const f = fixture();
      if (kind === "content") {
        write(f.checkout, "app/page.tsx", "human-owned revision\n");
      } else {
        chmodSync(path.join(f.checkout, "app/page.tsx"), 0o755);
      }
      const human = commit(f.checkout, "human revised this path");
      await expect(planOriginalPublicationRepair(f.request())).rejects.toThrow(
        "newer or unknown draft changes",
      );
      expect(f.writes).toEqual([]);
      expect(git(f.checkout, "rev-parse", "HEAD")).toBe(human);
    },
  );

  it("retains a path newly owned by current main instead of deleting it", async () => {
    const f = fixture();
    git(f.checkout, "switch", "main");
    write(f.checkout, "app/page.tsx", "a legitimate current base route\n");
    const newerBase = commit(f.checkout, "main now owns this path");
    git(f.checkout, "switch", f.headBranch);
    await expect(
      planOriginalPublicationRepair({ ...f.request(), baseSha: newerBase }),
    ).rejects.toThrow("current target base");
    expect(f.writes).toEqual([]);
    expect(git(f.checkout, "show", `${newerBase}:app/page.tsx`)).toContain(
      "legitimate current base",
    );
  });

  it.each([true, false])(
    "rejects shared-file human changes before resetting composition (originally changed=%s)",
    async (compositionChanged) => {
      const f = fixture({ compositionChanged });
      const value = parseObject(readFileSync(path.join(f.checkout, "package.json"), "utf-8"));
      write(f.checkout, "package.json", text({ ...value, humanOwned: true }));
      const human = commit(f.checkout, "human root-manifest change");
      await expect(planOriginalPublicationRepair(f.request())).rejects.toThrow(
        /Composition has (?:newer or unknown|unowned) draft changes/u,
      );
      expect(f.writes).toEqual([]);
      expect(git(f.checkout, "rev-parse", "HEAD")).toBe(human);
      expect(
        parseObject(readFileSync(path.join(f.checkout, "package.json"), "utf-8")),
      ).toHaveProperty("humanOwned", true);
    },
  );

  it("rejects changed publication proof before reading or writing the candidate", async () => {
    const f = fixture();
    await expect(
      planOriginalPublicationRepair({
        ...f.request(),
        owned: { ...f.owned, publication: { ...f.owned.publication, branchTree: "a".repeat(40) } },
      }),
    ).rejects.toThrow();
    expect(f.commands).toEqual([]);
    expect(f.writes).toEqual([]);
  });

  it("keeps unselected human files while rebuilding only current-base composition", async () => {
    const f = fixture();
    write(f.checkout, "docs/human-note.md", "retain this unowned change\n");
    commit(f.checkout, "human added another file");
    const plan = await planOriginalPublicationRepair(f.request());
    await stageOriginalPublicationRepair({
      sandbox: f.session,
      root: f.checkout,
      originalBase: f.originalBase,
      plan,
    });
    git(f.checkout, "merge", "--no-commit", "--no-ff", f.currentBase);
    await rebuildOriginalPublicationComposition({
      sandbox: f.session,
      root: f.checkout,
      workspaceRoot: f.workspace,
      appId,
      baseSha: f.currentBase,
      originalPackage: plan.originalPackage,
    });
    expect(readFileSync(path.join(f.checkout, "docs/human-note.md"), "utf-8")).toBe(
      "retain this unowned change\n",
    );
    expect(parseObject(readFileSync(path.join(f.checkout, "package.json"), "utf-8"))).toEqual({
      ...f.currentPackage,
      catalog: { ...f.currentPackage.catalog, needed: "workspace:*" },
    });
    expect(
      parseObject(readFileSync(path.join(f.checkout, "microfrontends.json"), "utf-8")),
    ).toMatchObject(f.currentRoutes);
    expect(f.lockSeeds).toEqual([f.currentLock]);
    expect(existsSync(path.join(f.checkout, "app/page.tsx"))).toBe(false);
  });

  it("prepares a fresh owned candidate through correction, native base merge and scoped review", async () => {
    const f = fixture();
    const prepared = await prepareDraftReconciliation({
      sandbox: f.session,
      workspaceRoot: f.workspace,
      repository: repo,
      appId,
      headBranch: f.headBranch,
      headSha: f.originalHead,
      baseBranch: "main",
      baseSha: f.currentBase,
      ownedPublication: f.owned,
      originalPublicationRepair: { discardAddedPaths: ["app/page.tsx"] },
    });
    expect(prepared.conflicts).toEqual([]);
    expect(existsSync(path.join(prepared.root, "app/page.tsx"))).toBe(false);
    expect(readFileSync(path.join(prepared.root, "apps/newer/app/page.tsx"), "utf-8")).toContain(
      "new base app",
    );
    expect(
      parseObject(readFileSync(path.join(prepared.root, "microfrontends.json"), "utf-8")),
    ).toMatchObject(f.currentRoutes);
    expect(prepared.publicationScope?.automaticMergeNonAppDigest).toBe(
      await nonAppIndexDigest(f.session, prepared.root, appId),
    );
    const review = await inspectDraftReconciliation({ sandbox: f.session, prepared });
    expect(review.unresolvedConflicts).toEqual([]);
    expect(review.baseChanges.some((change) => change.path === "app/page.tsx")).toBe(false);
    expect(
      review.headChanges.some(
        (change) => change.path === "app/page.tsx" && change.kind === "deleted",
      ),
    ).toBe(true);
    expect(git(f.checkout, "rev-parse", `refs/heads/${f.headBranch}`)).toBe(f.originalHead);
  });

  it("retains approved first registration while correcting a draft in the existing repository", async () => {
    const f = fixture({ firstPublication: true });
    const input = {
      sandbox: f.session,
      workspaceRoot: f.workspace,
      repository: repo,
      appId,
      headBranch: f.headBranch,
      headSha: f.originalHead,
      baseBranch: "main",
      baseSha: f.currentBase,
    };
    expect(git(f.checkout, "ls-tree", f.originalBase, "--", `apps/${appId}`)).toBe("");
    const unscoped = await prepareDraftReconciliation(input);
    const appPage = `apps/${appId}/app/page.tsx`;
    const correction = "export default 'corrected app implementation';\n";
    write(unscoped.root, appPage, correction);
    await expect(
      inspectDraftReconciliation({ sandbox: f.session, prepared: unscoped }),
    ).rejects.toThrow("differs from main at bun.lock");

    const prepared = await prepareDraftReconciliation({
      ...input,
      ownedPublication: f.owned,
      previousCandidate: unscoped,
      replayPreviousCandidate: true,
    });
    expect(prepared.root).not.toBe(unscoped.root);
    expect(prepared.conflicts).toEqual([]);
    expect(readFileSync(path.join(prepared.root, appPage), "utf-8")).toBe(correction);

    const review = await inspectDraftReconciliation({ sandbox: f.session, prepared });
    expect(review.baseChanges.map(({ path: file }) => file).toSorted()).toEqual(
      f.owned.proposal.approvedPaths,
    );
    expect(review.headChanges.map(({ path: file }) => file).toSorted()).toEqual([
      appPage,
      "docs/shared.md",
    ]);
    for (const registrationPath of ["bun.lock", "microfrontends.json"]) {
      expect(git(prepared.root, "rev-parse", `:${registrationPath}`)).toBe(
        git(f.checkout, "rev-parse", `${f.originalHead}:${registrationPath}`),
      );
    }
    expect(f.lockSeeds).toEqual([]);

    write(prepared.root, "bun.lock", "unreviewed replacement lockfile\n");
    await expect(inspectDraftReconciliation({ sandbox: f.session, prepared })).rejects.toThrow(
      "cannot accept reconciliation edit bun.lock",
    );
    git(prepared.root, "restore", "--worktree", "--", "bun.lock");

    write(prepared.root, "docs/shared.md", "unreviewed shared edit\n");
    git(prepared.root, "add", "--", "docs/shared.md");
    await expect(inspectDraftReconciliation({ sandbox: f.session, prepared })).rejects.toThrow(
      "Non-app content changed after Git prepared this owned draft merge",
    );
  });

  it.skipIf(availableBun === undefined)(
    "repairs a first publication's frozen lock without deleting files or losing saved app edits",
    async () => {
      if (availableBun === undefined) {
        throw new Error("The explicit local Bun fixture binary is unavailable");
      }
      const f = fixture({ firstPublication: true, realBun: true });
      const frozenInstall = (root: string) =>
        spawnSync(availableBun, ["install", "--frozen-lockfile", "--ignore-scripts"], {
          cwd: root,
          encoding: "utf-8",
          env: { ...process.env, BUN_INSTALL_CACHE_DIR: path.join(f.workspace, "bun-cache") },
        });
      const input = {
        sandbox: f.session,
        workspaceRoot: f.workspace,
        repository: repo,
        appId,
        headBranch: f.headBranch,
        headSha: f.originalHead,
        baseBranch: "main",
        baseSha: f.currentBase,
      };
      const previous = await prepareDraftReconciliation(input);
      const failure = frozenInstall(previous.root);
      expect(failure.status).not.toBe(0);
      expect(failure.stderr).toContain("lockfile had changes, but lockfile is frozen");
      const appPage = `apps/${appId}/app/page.tsx`;
      const edit = "export default 'preserved private app edit';\n";
      write(previous.root, appPage, edit);

      const repaired = await prepareDraftReconciliation({
        ...input,
        ownedPublication: f.owned,
        previousCandidate: previous,
        replayPreviousCandidate: true,
        originalPublicationRepair: { discardAddedPaths: [] },
      });
      expect(repaired.root).not.toBe(previous.root);
      expect(repaired.conflicts).toEqual([]);
      expect(readFileSync(path.join(repaired.root, appPage), "utf-8")).toBe(edit);
      expect(f.lockSeeds).toEqual([f.currentLock]);
      const proof = await inspectDraftReconciliation({ sandbox: f.session, prepared: repaired });
      expect(proof.baseChanges.map(({ path: file }) => file).toSorted()).toEqual(
        f.owned.proposal.approvedPaths,
      );
      const success = frozenInstall(repaired.root);
      expect(success.status, success.stderr).toBe(0);
      expect(git(f.checkout, "rev-parse", `refs/heads/${f.headBranch}`)).toBe(f.originalHead);
    },
  );

  it.skipIf(availableBun === undefined)(
    "regenerates a real Bun lock while retaining unrelated current workspaces and selections",
    async () => {
      const f = fixture({ realBun: true });
      const prepared = await prepareDraftReconciliation({
        sandbox: f.session,
        workspaceRoot: f.workspace,
        repository: repo,
        appId,
        headBranch: f.headBranch,
        headSha: f.originalHead,
        baseBranch: "main",
        baseSha: f.currentBase,
        ownedPublication: f.owned,
        originalPublicationRepair: { discardAddedPaths: ["app/page.tsx"] },
      });
      expect(f.lockSeeds).toEqual([f.currentLock]);
      const lock = readFileSync(path.join(prepared.root, "bun.lock"), "utf-8");
      expect(lock).toContain('"apps/existing"');
      expect(lock).toContain('"apps/newer"');
      expect(lock).toContain(`"apps/${appId}"`);
      expect(lock).toContain('"packages/existing"');
      expect(
        parseObject(
          readFileSync(path.join(prepared.root, "packages/existing/package.json"), "utf-8"),
        ),
      ).toHaveProperty("version", "2.0.0");
      expect(parseObject(readFileSync(path.join(prepared.root, "package.json"), "utf-8"))).toEqual({
        ...f.currentPackage,
        catalog: { ...f.currentPackage.catalog, needed: "workspace:*" },
      });
    },
  );
});
