import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createSupportedRepositoryFixture } from "../../evals/support/supported-repository";
import {
  assertCanonicalBranchWorktreeJournal,
  assertExactBranchWorktreeProposal,
  createBranchWorktreePublicationProposal,
} from "./branch-worktree-publication";
import {
  deriveBranchWorktreePublicationProposal,
  publishReviewedChangeSetToBranchWorktree,
  readBranchWorktreePublicationJournal,
  recoverBranchWorktreePublication,
  verifyBranchWorktreePublication,
} from "./node-branch-worktree-publication";
import { createReviewedChangeSetReceipt } from "./reviewed-change-set";
import { inspectSourceReceipt } from "./source-receipt";
import type { OverlayChange } from "./target-apply";

const hash = (value: unknown) =>
  createHash("sha256")
    .update(
      typeof value === "string" || value instanceof Uint8Array
        ? value
        : JSON.stringify(value),
    )
    .digest("hex");

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

async function fixture() {
  const root = createSupportedRepositoryFixture();
  await writeFile(join(root, "obsolete.txt"), "remove\n");
  await writeFile(
    join(root, ".gitattributes"),
    "filtered.txt filter=fixture\n",
  );
  await writeFile(join(root, "filtered.txt"), "raw filtered content\n");
  git(root, ["add", "obsolete.txt", ".gitattributes", "filtered.txt"]);
  git(root, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "branch publication fixture",
  ]);
  const source = await inspectSourceReceipt("existing-repository", root);
  const topology = join(root, "apps/shell/microfrontends.json");
  const oldTopology = await readFile(topology);
  const nextTopology = Buffer.from('{"branch":true}\n');
  const added = Buffer.from("new branch file\n");
  const acceptedAppSpec = Buffer.from("# Accepted AppSpec\n");
  const appSpecPath = "prototype/example/app-spec.md";
  const changes: OverlayChange[] = [
    {
      path: "apps/example/new.txt",
      kind: "added",
      after: { mode: "644", digest: hash(added) },
    },
    {
      path: "apps/shell/microfrontends.json",
      kind: "modified",
      before: { mode: "644", digest: hash(oldTopology) },
      after: { mode: "644", digest: hash(nextTopology) },
    },
    {
      path: "obsolete.txt",
      kind: "deleted",
      before: { mode: "644", digest: hash("remove\n") },
    },
    {
      path: appSpecPath,
      kind: "added",
      after: { mode: "644", digest: hash(acceptedAppSpec) },
    },
  ];
  const unsigned = {
    version: 2 as const,
    validationDigest: "a".repeat(64),
    applyDigest: "b".repeat(64),
    proposalDigest: "c".repeat(64),
    contractDigest: source.contractDigest,
    repositoryContractDigest: source.contractDigest,
    sourceSha: source.sourceSha,
    sourceTree: source.sourceTree,
    eligibilityDigest: source.eligibilityDigest,
    workspaceDigest: "d".repeat(64),
    appSpecDigest: hash(acceptedAppSpec),
    appSpecPath,
    artifactRevision: "f".repeat(64),
    dependencyReceiptDigest: "1".repeat(64),
    identityDigest: "2".repeat(64),
    imageDigest: `fixture@sha256:${"3".repeat(64)}`,
    dependencyCacheDigest: `sha256:${"4".repeat(64)}`,
    targetReceipt: {
      version: 1 as const,
      contractPath: "apps/example/app.contract.json",
      topology: {
        path: "apps/shell/microfrontends.json",
        oldDigest: "5".repeat(64),
        newDigest: "6".repeat(64),
      },
    },
    preTreeDigest: "7".repeat(64),
    postTreeDigest: "8".repeat(64),
    changedContentDigest: hash(changes),
    changes,
    approvedPaths: changes.map(({ path }) => path),
  };
  const changeSet = { ...unsigned, digest: hash(unsigned) };
  const review = createReviewedChangeSetReceipt(changeSet, "review-call");
  const overlay = new Map<string, Uint8Array>([
    ["apps/example/new.txt", added],
    ["apps/shell/microfrontends.json", nextTopology],
    [appSpecPath, acceptedAppSpec],
  ]);
  return {
    root: source.sourcePath,
    source,
    sourceReceipt: source,
    review,
    overlay,
    nextTopology,
    acceptedAppSpec,
    appSpecPath,
  };
}

describe(
  "approval-bound branch-worktree publication",
  { timeout: 30_000 },
  () => {
    let publicationRootPath: string;

    const useIsolatedPublicationRoot = async () => {
      publicationRootPath = await realpath(
        await mkdtemp(join(tmpdir(), "branch-publication-test-")),
      );
      await chmod(publicationRootPath, 0o700);
      vi.stubEnv("APP_BUILDER_BRANCH_WORKTREE_ROOT", publicationRootPath);
    };

    beforeEach(async () => {
      vi.stubEnv("APP_BUILDER_TEST_MODEL", "1");
      vi.stubEnv("APP_BUILDER_BRANCH_WORKTREE_PUBLICATION", "1");
      await useIsolatedPublicationRoot();
    });

    it.each(["path-less-v1", "wrong-version"] as const)(
      "rejects a rehashed %s review before branch publication",
      async (mutation) => {
        const candidate = await fixture();
        const malformed = structuredClone(candidate.review) as Record<
          string,
          unknown
        >;
        if (mutation === "path-less-v1") delete malformed.appSpecPath;
        malformed.version = 1;
        const reviewedByCallId = malformed.reviewedByCallId;
        delete malformed.digest;
        delete malformed.changeSetDigest;
        delete malformed.reviewedByCallId;
        const changeSetDigest = hash(malformed);
        const outer = {
          ...malformed,
          digest: changeSetDigest,
          changeSetDigest,
          reviewedByCallId,
        };
        outer.digest = hash(outer);
        expect(() =>
          createBranchWorktreePublicationProposal({
            sourceReceipt: candidate.sourceReceipt,
            source: {} as never,
            review: outer as never,
            worktreePath: "/tmp/unused",
            publicationRootPath: "/tmp",
            publicationRootIdentity: { device: "1", inode: "1" },
          }),
        ).toThrow(/canonical V2 reviewed change set/u);
      },
    );
    it("rejects a rehashed wrong-version branch-publication proposal", () => {
      const unsigned = { version: 1, intendedOutcome: "forged" };
      expect(() =>
        assertExactBranchWorktreeProposal({
          ...unsigned,
          digest: hash(unsigned),
        } as never),
      ).toThrow(/canonical V2 branch-worktree publication proposal/u);
    });
    afterEach(() => vi.unstubAllEnvs());

    it("creates a deterministic uncommitted branch worktree and leaves the source checkout exact", async () => {
      const input = await fixture();
      await writeFile(join(input.root, "unrelated.txt"), "preserve me\n");
      const sourceStatus = git(input.root, [
        "status",
        "--porcelain=v2",
        "--untracked-files=all",
      ]);
      const proposal = await deriveBranchWorktreePublicationProposal(input);
      assertExactBranchWorktreeProposal(proposal);
      expect(proposal.branchName).toMatch(
        /^app-builder\/review-[0-9a-f]{64}$/u,
      );
      const hostile = await mkdtemp(
        join(tmpdir(), "branch-publication-hostile-"),
      );
      const hookMarker = join(hostile, "hook-ran");
      const filterMarker = join(hostile, "filter-ran");
      const hook = join(hostile, "post-checkout");
      const filter = join(hostile, "smudge");
      await writeFile(hook, `#!/bin/sh\nprintf ran > '${hookMarker}'\n`);
      await writeFile(
        filter,
        `#!/bin/sh\nprintf ran > '${filterMarker}'\ncat\n`,
      );
      await chmod(hook, 0o755);
      await chmod(filter, 0o755);
      git(input.root, ["config", "core.hooksPath", hostile]);
      git(input.root, ["config", "filter.fixture.smudge", filter]);
      const lock = join(
        publicationRootPath,
        "locks",
        `${proposal.publicationIdentityDigest}.lock`,
      );
      await mkdir(dirname(lock), { recursive: true, mode: 0o700 });
      await chmod(dirname(lock), 0o700);
      await writeFile(lock, "stale advisory-lock file content\n");
      await chmod(lock, 0o600);
      const staging = join(
        publicationRootPath,
        "staging",
        proposal.publicationIdentityDigest,
      );
      await mkdir(staging, { recursive: true, mode: 0o700 });
      await chmod(dirname(staging), 0o700);
      await chmod(staging, 0o700);
      await writeFile(join(staging, "interrupted-write"), "partial");
      const receipt = await publishReviewedChangeSetToBranchWorktree({
        ...input,
        proposal,
        publishedByCallId: "publish-call",
        readOverlayFile: async (path) => input.overlay.get(path) ?? null,
      });
      if (receipt.status !== "succeeded")
        throw new Error(receipt.failureMessage);
      expect(receipt.status).toBe("succeeded");
      assertCanonicalBranchWorktreeJournal(receipt);
      await verifyBranchWorktreePublication({ receipt, ...input });
      expect(git(input.root, ["rev-parse", "HEAD"]).trim()).toBe(
        input.source.sourceSha,
      );
      expect(
        git(input.root, ["status", "--porcelain=v2", "--untracked-files=all"]),
      ).toBe(sourceStatus);
      expect(git(proposal.worktreePath, ["rev-parse", "HEAD"]).trim()).toBe(
        input.source.sourceSha,
      );
      expect(
        git(proposal.worktreePath, ["log", "-1", "--format=%s"]).trim(),
      ).toBe("branch publication fixture");
      expect(
        await readFile(
          join(proposal.worktreePath, "apps/shell/microfrontends.json"),
        ),
      ).toEqual(input.nextTopology);
      expect(
        await readFile(join(proposal.worktreePath, input.appSpecPath)),
      ).toEqual(input.acceptedAppSpec);
      await expect(
        readFile(join(proposal.worktreePath, "obsolete.txt")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(hookMarker)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(readFile(filterMarker)).rejects.toMatchObject({
        code: "ENOENT",
      });
    });

    it("records partial failure and resumes only through explicit digest-bound recovery", async () => {
      const input = await fixture();
      const proposal = await deriveBranchWorktreePublicationProposal(input);
      const failed = await publishReviewedChangeSetToBranchWorktree({
        ...input,
        proposal,
        publishedByCallId: "failed-call",
        readOverlayFile: async (path) => input.overlay.get(path) ?? null,
        hooks: {
          afterPathMutation: (_path, index) => {
            if (index === 0) throw new Error("fixture partial failure");
          },
        },
      });
      expect(failed).toMatchObject({
        status: "failed",
        recoveryRequired: true,
        branchCreated: true,
        worktreeCreated: true,
      });
      const durable = await readBranchWorktreePublicationJournal(proposal);
      expect(durable?.digest).toBe(failed.digest);
      await rm(proposal.worktreePath, { recursive: true });
      const recovered = await recoverBranchWorktreePublication({
        ...input,
        proposal,
        recoveredByCallId: "recovery-call",
        expectedJournalDigest: failed.digest,
        readOverlayFile: async (path) => input.overlay.get(path) ?? null,
      });
      expect(recovered).toMatchObject({
        status: "succeeded",
        recoveryOfDigest: failed.digest,
        recoveryRequired: false,
      });
    });

    it("recovers an exact branch created before a worktree crash window", async () => {
      const input = await fixture();
      const proposal = await deriveBranchWorktreePublicationProposal(input);
      const failed = await publishReviewedChangeSetToBranchWorktree({
        ...input,
        proposal,
        publishedByCallId: "branch-only-call",
        readOverlayFile: async (path) => input.overlay.get(path) ?? null,
        hooks: {
          afterBranchCreation: () => {
            throw new Error("fixture branch-only interruption");
          },
        },
      });
      expect(failed).toMatchObject({
        status: "failed",
        branchCreated: true,
        worktreeCreated: false,
        recoveryRequired: true,
      });
      await mkdir(proposal.worktreePath, { recursive: true, mode: 0o700 });
      await chmod(dirname(proposal.worktreePath), 0o700);
      await chmod(proposal.worktreePath, 0o700);
      const conflict = join(proposal.worktreePath, "unapproved.txt");
      await writeFile(conflict, "do not delete\n");
      const conflicted = await recoverBranchWorktreePublication({
        ...input,
        proposal,
        recoveredByCallId: "branch-only-recovery",
        expectedJournalDigest: failed.digest,
        readOverlayFile: async (path) => input.overlay.get(path) ?? null,
      });
      expect(conflicted).toMatchObject({
        status: "failed",
        reason: "recovery-conflict",
        recoveryRequired: true,
      });
      expect(await readFile(conflict, "utf8")).toBe("do not delete\n");
      await rm(proposal.worktreePath, { recursive: true });
      const recovered = await recoverBranchWorktreePublication({
        ...input,
        proposal,
        recoveredByCallId: "branch-only-recovery-after-conflict",
        expectedJournalDigest: conflicted.digest,
        readOverlayFile: async (path) => input.overlay.get(path) ?? null,
      });
      if (recovered.status !== "succeeded")
        throw new Error(recovered.failureMessage);
      expect(recovered.status).toBe("succeeded");
    });

    it("recovers a lost response after side effects without creating a second identity", async () => {
      const input = await fixture();
      const proposal = await deriveBranchWorktreePublicationProposal(input);
      await expect(
        publishReviewedChangeSetToBranchWorktree({
          ...input,
          proposal,
          publishedByCallId: "lost-call",
          readOverlayFile: async (path) => input.overlay.get(path) ?? null,
          hooks: {
            beforeTerminalJournal: () => {
              throw new Error("fixture lost response");
            },
            preserveNonterminalJournal: true,
          },
        }),
      ).rejects.toThrow(/lost response/u);
      const pending = await readBranchWorktreePublicationJournal(proposal);
      expect(pending?.status).toBe("pending");
      const recovered = await recoverBranchWorktreePublication({
        ...input,
        proposal,
        recoveredByCallId: "lost-recovery",
        expectedJournalDigest: pending!.digest,
        readOverlayFile: async (path) => input.overlay.get(path) ?? null,
      });
      expect(recovered.status).toBe("succeeded");
      expect(
        git(input.root, ["branch", "--list", proposal.branchName]).trim(),
      ).not.toBe("");
    });

    it("rejects approved-path overlap and creates no branch", async () => {
      const input = await fixture();
      await mkdir(dirname(join(input.root, "apps/example/new.txt")), {
        recursive: true,
      });
      await writeFile(join(input.root, "apps/example/new.txt"), "collision\n");
      await expect(
        deriveBranchWorktreePublicationProposal(input),
      ).rejects.toThrow(/dirty overlap/u);
      expect(
        git(input.root, ["branch", "--list", "app-builder/*"]).trim(),
      ).toBe("");
    });

    it("rejects source status or remote drift before durable intent or branch creation", async () => {
      for (const drift of ["status", "remote"] as const) {
        const input = await fixture();
        const proposal = await deriveBranchWorktreePublicationProposal(input);
        if (drift === "status")
          await writeFile(
            join(input.root, "unrelated-after-approval.txt"),
            "drift\n",
          );
        else
          git(input.root, [
            "remote",
            "add",
            "after-approval",
            "https://example.invalid/repository.git",
          ]);
        await expect(
          publishReviewedChangeSetToBranchWorktree({
            ...input,
            proposal,
            publishedByCallId: `drift-${drift}`,
            readOverlayFile: async (path) => input.overlay.get(path) ?? null,
          }),
        ).rejects.toThrow(/changed after approval/u);
        expect(
          await readBranchWorktreePublicationJournal(proposal),
        ).toBeUndefined();
        expect(
          git(input.root, ["branch", "--list", proposal.branchName]).trim(),
        ).toBe("");
      }
    });

    it("rejects a deterministic branch collision without adopting it", async () => {
      const input = await fixture();
      const proposal = await deriveBranchWorktreePublicationProposal(input);
      git(input.root, ["branch", proposal.branchName, proposal.baseSha]);
      await expect(
        publishReviewedChangeSetToBranchWorktree({
          ...input,
          proposal,
          publishedByCallId: "collision",
          readOverlayFile: async (path) => input.overlay.get(path) ?? null,
        }),
      ).rejects.toThrow(/already exists/u);
      expect(
        await readBranchWorktreePublicationJournal(proposal),
      ).toBeUndefined();
    });

    it("lets the OS lock exclude a concurrent publication process holder", async () => {
      const input = await fixture();
      const proposal = await deriveBranchWorktreePublicationProposal(input);
      let releasePending!: () => void;
      let pendingReached!: () => void;
      const atPending = new Promise<void>((resolve) => {
        pendingReached = resolve;
      });
      const continuePublication = new Promise<void>((resolve) => {
        releasePending = resolve;
      });
      const first = publishReviewedChangeSetToBranchWorktree({
        ...input,
        proposal,
        publishedByCallId: "lock-holder",
        readOverlayFile: async (path) => input.overlay.get(path) ?? null,
        hooks: {
          afterPendingJournal: async () => {
            pendingReached();
            await continuePublication;
          },
        },
      });
      await atPending;
      await expect(
        publishReviewedChangeSetToBranchWorktree({
          ...input,
          proposal,
          publishedByCallId: "lock-contender",
          readOverlayFile: async (path) => input.overlay.get(path) ?? null,
        }),
      ).rejects.toThrow(/already in progress/u);
      releasePending();
      expect((await first).status).toBe("succeeded");
    });

    it("refuses success if the original checkout changes after worktree mutation", async () => {
      const input = await fixture();
      const proposal = await deriveBranchWorktreePublicationProposal(input);
      const receipt = await publishReviewedChangeSetToBranchWorktree({
        ...input,
        proposal,
        publishedByCallId: "late-source-drift",
        readOverlayFile: async (path) => input.overlay.get(path) ?? null,
        hooks: {
          beforeSourcePostcondition: () =>
            writeFile(join(input.root, "late-unrelated.txt"), "drift\n"),
        },
      });
      expect(receipt).toMatchObject({
        status: "failed",
        recoveryRequired: true,
      });
      if (receipt.status !== "failed") throw new Error("expected failure");
      expect(receipt.failureMessage).toMatch(/changed after approval/u);
    });

    it("rejects unsafe root permissions and overlap with the source checkout", async () => {
      const input = await fixture();
      await chmod(publicationRootPath, 0o755);
      await expect(
        deriveBranchWorktreePublicationProposal(input),
      ).rejects.toThrow(/canonical builder-owned directory/u);

      await chmod(input.root, 0o700);
      vi.stubEnv("APP_BUILDER_BRANCH_WORKTREE_ROOT", input.root);
      await expect(
        deriveBranchWorktreePublicationProposal(input),
      ).rejects.toThrow(/overlaps the source checkout/u);
    });

    it("rejects symlinked publication path families before durable intent", async () => {
      for (const family of ["locks", "journals", "staging", "worktrees"]) {
        const isolatedRoot = await realpath(
          await mkdtemp(join(tmpdir(), `branch-publication-${family}-`)),
        );
        await chmod(isolatedRoot, 0o700);
        vi.stubEnv("APP_BUILDER_BRANCH_WORKTREE_ROOT", isolatedRoot);
        const input = await fixture();
        const proposal = await deriveBranchWorktreePublicationProposal(input);
        const outside = await realpath(
          await mkdtemp(
            join(tmpdir(), `branch-publication-outside-${family}-`),
          ),
        );
        await symlink(outside, join(isolatedRoot, family));
        await expect(
          publishReviewedChangeSetToBranchWorktree({
            ...input,
            proposal,
            publishedByCallId: `symlink-${family}`,
            readOverlayFile: async (path) => input.overlay.get(path) ?? null,
          }),
        ).rejects.toThrow(/symbolic link/u);
        expect(
          git(input.root, ["branch", "--list", proposal.branchName]).trim(),
        ).toBe("");
        await expect(
          readFile(join(outside, `${proposal.publicationIdentityDigest}.json`)),
        ).rejects.toMatchObject({
          code: "ENOENT",
        });
      }
    });

    it("rejects a hard-linked OS lock inode", async () => {
      const input = await fixture();
      const proposal = await deriveBranchWorktreePublicationProposal(input);
      const lockPath = join(
        publicationRootPath,
        "locks",
        `${proposal.publicationIdentityDigest}.lock`,
      );
      await mkdir(dirname(lockPath), { mode: 0o700 });
      await writeFile(lockPath, "lock\n", { mode: 0o600 });
      const alias = join(publicationRootPath, "lock-alias");
      await link(lockPath, alias);
      await expect(
        publishReviewedChangeSetToBranchWorktree({
          ...input,
          proposal,
          publishedByCallId: "hard-linked-lock",
          readOverlayFile: async (path) => input.overlay.get(path) ?? null,
        }),
      ).rejects.toThrow(/exclusive owner-only inode/u);
    });

    it("drops every inherited Git, loader, and user-config control vector", async () => {
      const input = await fixture();
      const hostile = await realpath(
        await mkdtemp(join(tmpdir(), "branch-publication-env-hostile-")),
      );
      for (const name of [
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_COMMON_DIR",
        "GIT_INDEX_FILE",
        "GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
        "GIT_QUARANTINE_PATH",
        "GIT_NAMESPACE",
        "GIT_SHALLOW_FILE",
        "GIT_GRAFT_FILE",
        "GIT_REPLACE_REF_BASE",
        "GIT_CONFIG",
        "GIT_CONFIG_PARAMETERS",
        "GIT_ATTR_GLOBAL",
        "GIT_ATTR_SYSTEM",
        "GIT_ATTR_SOURCE",
        "GIT_EXEC_PATH",
        "GIT_DEFAULT_HASH",
        "GIT_DEFAULT_REF_FORMAT",
        "LD_PRELOAD",
        "LD_LIBRARY_PATH",
        "LD_AUDIT",
        "NODE_PATH",
        "DYLD_INSERT_LIBRARIES",
        "DYLD_LIBRARY_PATH",
        "DYLD_FRAMEWORK_PATH",
        "HOME",
        "XDG_CONFIG_HOME",
      ])
        vi.stubEnv(name, hostile);
      vi.stubEnv("NODE_OPTIONS", `--require=${hostile}`);
      vi.stubEnv("GIT_CONFIG_COUNT", "1");
      vi.stubEnv("GIT_CONFIG_KEY_0", "core.hooksPath");
      vi.stubEnv("GIT_CONFIG_VALUE_0", hostile);
      const proposal = await deriveBranchWorktreePublicationProposal(input);
      expect(proposal.sourcePath).toBe(input.root);
      expect(proposal.baseSha).toBe(input.source.sourceSha);
      const receipt = await publishReviewedChangeSetToBranchWorktree({
        ...input,
        proposal,
        publishedByCallId: "hostile-helper-environment",
        readOverlayFile: async (path) => input.overlay.get(path) ?? null,
      });
      expect(receipt.status).toBe("succeeded");
    });

    it("cleanly releases a graceful interruption before durable intent", async () => {
      const input = await fixture();
      const proposal = await deriveBranchWorktreePublicationProposal(input);
      await expect(
        publishReviewedChangeSetToBranchWorktree({
          ...input,
          proposal,
          publishedByCallId: "graceful-before-intent",
          readOverlayFile: async (path) => input.overlay.get(path) ?? null,
          hooks: {
            beforePendingJournal: () => {
              throw new Error("fixture graceful cancellation");
            },
          },
        }),
      ).rejects.toThrow(/graceful cancellation/u);
      expect(
        await readBranchWorktreePublicationJournal(proposal),
      ).toBeUndefined();
      expect(
        git(input.root, ["branch", "--list", proposal.branchName]).trim(),
      ).toBe("");
      await expect(
        readFile(
          join(
            publicationRootPath,
            "locks",
            `${proposal.publicationIdentityDigest}.lock`,
          ),
          "utf8",
        ),
      ).resolves.toBe("");
      const retry = await publishReviewedChangeSetToBranchWorktree({
        ...input,
        proposal,
        publishedByCallId: "graceful-before-intent-retry",
        readOverlayFile: async (path) => input.overlay.get(path) ?? null,
      });
      expect(retry.status).toBe("succeeded");
    });

    it("fails closed when the OS lock helper dies before or after durable intent", async () => {
      const waitForExit = () =>
        new Promise<void>((resolve) => setTimeout(resolve, 25));
      const before = await fixture();
      const beforeProposal =
        await deriveBranchWorktreePublicationProposal(before);
      await expect(
        publishReviewedChangeSetToBranchWorktree({
          ...before,
          proposal: beforeProposal,
          publishedByCallId: "lock-dies-before-intent",
          readOverlayFile: async (path) => before.overlay.get(path) ?? null,
          hooks: {
            afterLockReady: async (pid) => {
              process.kill(pid, "SIGKILL");
              await waitForExit();
            },
          },
        }),
      ).rejects.toThrow(/lock helper exited before release/u);
      expect(
        await readBranchWorktreePublicationJournal(beforeProposal),
      ).toBeUndefined();
      expect(
        git(before.root, [
          "branch",
          "--list",
          beforeProposal.branchName,
        ]).trim(),
      ).toBe("");
      const beforeLeasePath = join(
        publicationRootPath,
        "locks",
        `${beforeProposal.publicationIdentityDigest}.lock`,
      );
      await expect(readFile(beforeLeasePath, "utf8")).resolves.toMatch(
        /^APP_BUILDER_PUBLICATION_LEASE_V1:/u,
      );
      await expect(
        publishReviewedChangeSetToBranchWorktree({
          ...before,
          proposal: beforeProposal,
          publishedByCallId: "contender-after-pre-intent-loss",
          readOverlayFile: async (path) => before.overlay.get(path) ?? null,
        }),
      ).rejects.toThrow(/abandoned publication lease/u);
      expect(
        await readBranchWorktreePublicationJournal(beforeProposal),
      ).toBeUndefined();
      expect(
        git(before.root, [
          "branch",
          "--list",
          beforeProposal.branchName,
        ]).trim(),
      ).toBe("");

      await useIsolatedPublicationRoot();
      const after = await fixture();
      const afterProposal =
        await deriveBranchWorktreePublicationProposal(after);
      let holderPid = 0;
      let contenderResult:
        Promise<{ ok: true } | { message: string; ok: false }> | undefined;
      await expect(
        publishReviewedChangeSetToBranchWorktree({
          ...after,
          proposal: afterProposal,
          publishedByCallId: "lock-dies-after-intent",
          readOverlayFile: async (path) => after.overlay.get(path) ?? null,
          hooks: {
            afterLockReady: (pid) => {
              holderPid = pid;
            },
            afterPendingJournal: async () => {
              process.kill(holderPid, "SIGKILL");
              contenderResult = publishReviewedChangeSetToBranchWorktree({
                ...after,
                proposal: afterProposal,
                publishedByCallId: "lock-contender-after-holder-death",
                readOverlayFile: async (path) =>
                  after.overlay.get(path) ?? null,
              }).then(
                () => ({ ok: true as const }),
                (error: unknown) => ({
                  message:
                    error instanceof Error ? error.message : String(error),
                  ok: false as const,
                }),
              );
              await waitForExit();
            },
          },
        }),
      ).rejects.toThrow(/lock helper exited before release/u);
      expect(
        await readBranchWorktreePublicationJournal(afterProposal),
      ).toMatchObject({ status: "pending" });
      expect(
        git(after.root, ["branch", "--list", afterProposal.branchName]).trim(),
      ).toBe("");
      expect(contenderResult).toBeDefined();
      const contender = await contenderResult!;
      expect(contender.ok).toBe(false);
      if (!contender.ok) {
        expect(contender.message).toMatch(
          /already in progress|use status or explicit recovery/u,
        );
      }
      const abandonedLeasePath = join(
        publicationRootPath,
        "locks",
        `${afterProposal.publicationIdentityDigest}.lock`,
      );
      await expect(readFile(abandonedLeasePath, "utf8")).resolves.toMatch(
        /^APP_BUILDER_PUBLICATION_LEASE_V1:/u,
      );
      await rm(
        join(
          publicationRootPath,
          "journals",
          `${afterProposal.publicationIdentityDigest}.json`,
        ),
      );
      await expect(
        publishReviewedChangeSetToBranchWorktree({
          ...after,
          proposal: afterProposal,
          publishedByCallId: "lock-contender-after-loss-observed",
          readOverlayFile: async (path) => after.overlay.get(path) ?? null,
        }),
      ).rejects.toThrow(/abandoned publication lease/u);
      expect(
        git(after.root, ["branch", "--list", afterProposal.branchName]).trim(),
      ).toBe("");
    });
  },
);
