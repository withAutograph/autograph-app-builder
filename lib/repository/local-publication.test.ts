import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createSupportedRepositoryFixture } from "../../evals/support/supported-repository";
import {
  assertCanonicalLocalPublicationJournal,
  assertExactDurablePublicationSuccess,
  assertExactProposal,
  createLocalPublicationProposal,
  receiptDigest,
  type LocalPublicationJournal,
  type LocalPublicationPendingReceipt,
} from "./local-publication";
import {
  deriveLocalPublicationProposal,
  parseGitStatusV2,
  publishReviewedChangeSet,
  readLocalPublicationJournal,
  verifyPublishedChangeSet,
} from "./node-local-publication";
import { createReviewedChangeSetReceipt } from "./reviewed-change-set";
import { inspectSourceReceipt, type SourceReceipt } from "./source-receipt";
import type { OverlayChange } from "./target-apply";

const hash = (value: Uint8Array | string | unknown) =>
  createHash("sha256")
    .update(
      typeof value === "string" || value instanceof Uint8Array
        ? value
        : JSON.stringify(value),
    )
    .digest("hex");

function git(root: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, HK: "0" },
  });
}

async function seedTracked(
  root: string,
  files: Record<string, string>,
): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  git(root, ["add", "--", ...Object.keys(files)]);
  git(root, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "publication fixture",
  ]);
}

async function fixtureRoot(): Promise<{ root: string; source: SourceReceipt }> {
  const fixture = createSupportedRepositoryFixture();
  await seedTracked(fixture, {
    "obsolete.txt": "remove me\n",
    "unrelated-staged.txt": "staged original\n",
    "unrelated-unstaged.txt": "unstaged original\n",
  });
  const source = await inspectSourceReceipt("existing-repository", fixture);
  return { root: source.sourcePath, source };
}

async function reviewFor(
  root: string,
  source: SourceReceipt,
  desired: Record<
    string,
    | { kind: "added" | "modified"; bytes: Uint8Array; mode?: "644" | "755" }
    | { kind: "deleted" }
  >,
) {
  const changes: OverlayChange[] = [];
  const overlay = new Map<string, Uint8Array>();
  for (const [path, value] of Object.entries(desired).toSorted(
    ([left], [right]) => left.localeCompare(right),
  )) {
    if (value.kind === "added") {
      changes.push({
        path,
        kind: "added",
        after: { mode: value.mode ?? "644", digest: hash(value.bytes) },
      });
      overlay.set(path, value.bytes);
      continue;
    }
    const before = await readFile(join(root, path));
    const mode = (await import("node:fs/promises"))
      .stat(join(root, path))
      .then((stat) =>
        (stat.mode & 0o111) === 0 ? ("644" as const) : ("755" as const),
      );
    if (value.kind === "deleted") {
      changes.push({
        path,
        kind: "deleted",
        before: { mode: await mode, digest: hash(before) },
      });
      continue;
    }
    changes.push({
      path,
      kind: "modified",
      before: { mode: await mode, digest: hash(before) },
      after: { mode: value.mode ?? "644", digest: hash(value.bytes) },
    });
    overlay.set(path, value.bytes);
  }
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
    appSpecDigest: "e".repeat(64),
    appSpecPath: "prototype/example/app-spec.md",
    artifactRevision: "f".repeat(64),
    dependencyReceiptDigest: "1".repeat(64),
    identityDigest: "2".repeat(64),
    imageDigest: `fixture@sha256:${"3".repeat(64)}`,
    dependencyCacheDigest: `sha256:${"4".repeat(64)}`,
    dependencyCacheContentDigest: "5".repeat(64),
    targetReceipt: {
      version: 1 as const,
      contractPath: "apps/example/app.contract.json",
      topology: {
        path: "microfrontends.json",
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
  return {
    review: createReviewedChangeSetReceipt(changeSet, "review-call"),
    overlay,
  };
}

async function combinedFixture() {
  const { root, source } = await fixtureRoot();
  const modified = Buffer.from('{"local":true}\n');
  const added = Buffer.from("new executable\n");
  const reviewed = await reviewFor(root, source, {
    "apps/example/new file.sh": { kind: "added", bytes: added, mode: "755" },
    "microfrontends.json": { kind: "modified", bytes: modified },
    "obsolete.txt": { kind: "deleted" },
  });
  return { root, source, modified, added, ...reviewed };
}

function rehashHistoricalReview(
  review: Awaited<ReturnType<typeof reviewFor>>["review"],
  mutation: "path-less-v1" | "wrong-version",
) {
  const candidate = structuredClone(review) as Record<string, unknown>;
  if (mutation === "path-less-v1") delete candidate.appSpecPath;
  candidate.version = 1;
  const reviewedByCallId = candidate.reviewedByCallId;
  delete candidate.digest;
  delete candidate.changeSetDigest;
  delete candidate.reviewedByCallId;
  const changeSetDigest = hash(candidate);
  return {
    ...candidate,
    digest: changeSetDigest,
    changeSetDigest,
    reviewedByCallId,
    outerDigest: undefined,
  } as Record<string, unknown>;
}

async function materializeApprovedPostimages(
  root: string,
  proposal: Awaited<ReturnType<typeof deriveLocalPublicationProposal>>,
  overlay: ReadonlyMap<string, Uint8Array>,
  count: number,
): Promise<void> {
  for (const path of proposal.executionPaths.slice(0, count)) {
    const change = proposal.changes.find(
      (candidate) => candidate.path === path,
    )!;
    const target = join(root, path);
    if (change.after === undefined) {
      await rm(target, { force: true });
      continue;
    }
    const bytes = overlay.get(path)!;
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
    await chmod(target, Number.parseInt(change.after.mode, 8));
  }
}

describe("porcelain-v2 status parsing", () => {
  it("keeps spaces and both sides of a rename", () => {
    const output = [
      "1 .M N... 100644 100644 100644 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa path with spaces.txt",
      "2 R. N... 100644 100644 100644 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa R100 renamed path.txt",
      "old path.txt",
      "? untracked path.txt",
      "",
    ].join("\0");
    expect(parseGitStatusV2(output)).toEqual([
      {
        path: "path with spaces.txt",
        indexStatus: ".",
        worktreeStatus: "M",
        indexMode: "100644",
        indexObjectId: "a".repeat(40),
      },
      {
        path: "renamed path.txt",
        originalPath: "old path.txt",
        indexStatus: "R",
        worktreeStatus: ".",
        indexMode: "100644",
        indexObjectId: "a".repeat(40),
      },
      { path: "untracked path.txt", indexStatus: "?", worktreeStatus: "?" },
    ]);
  });
});

describe("approval-bound local publication", () => {
  beforeEach(() => {
    vi.stubEnv("APP_BUILDER_TEST_MODEL", "1");
    vi.stubEnv("APP_BUILDER_LOCAL_PUBLICATION", "1");
  });
  afterEach(() => vi.unstubAllEnvs());

  it.each(["path-less-v1", "wrong-version"] as const)(
    "rejects a rehashed %s review before local publication",
    async (mutation) => {
      const fixture = await combinedFixture();
      const malformed = rehashHistoricalReview(fixture.review, mutation);
      const outer = { ...malformed };
      delete outer.outerDigest;
      outer.digest = hash(outer);
      expect(() =>
        createLocalPublicationProposal({
          sourceReceipt: fixture.source,
          destination: {} as never,
          review: outer as never,
        }),
      ).toThrow(/canonical V2 reviewed change set/u);
    },
  );

  it("rejects a rehashed wrong-version local-publication proposal", () => {
    const unsigned = { version: 1, intendedOutcome: "forged" };
    expect(() =>
      assertExactProposal({ ...unsigned, digest: hash(unsigned) } as never),
    ).toThrow(/canonical V2 local-publication proposal/u);
  });

  it("applies combined add/modify/delete and exactly preserves unrelated staged, unstaged, and untracked work", async () => {
    const fixture = await combinedFixture();
    await writeFile(
      join(fixture.root, "unrelated-staged.txt"),
      "staged next\n",
    );
    git(fixture.root, ["add", "--", "unrelated-staged.txt"]);
    await writeFile(
      join(fixture.root, "unrelated-unstaged.txt"),
      "unstaged next\n",
    );
    await writeFile(
      join(fixture.root, "untracked with spaces.txt"),
      "untracked next\n",
    );
    const beforeIndex = git(fixture.root, ["diff", "--cached", "--binary"]);
    const beforeWorktree = git(fixture.root, [
      "diff",
      "--binary",
      "--",
      "unrelated-unstaged.txt",
    ]);
    const proposal = await deriveLocalPublicationProposal({
      destinationPath: fixture.root,
      sourceReceipt: fixture.source,
      review: fixture.review,
    });
    const result = await publishReviewedChangeSet({
      proposal,
      sourceReceipt: fixture.source,
      review: fixture.review,
      publishedByCallId: "publication-call",
      readOverlayFile: async (path) => fixture.overlay.get(path) ?? null,
    });
    if (!result.ok) throw new Error(result.receipt.failureMessage);
    expect(result).toMatchObject({ ok: true });
    expect(proposal.executionPaths.at(-1)).toBe("microfrontends.json");
    expect(result.receipt.appliedPaths).toEqual(proposal.executionPaths);
    expect(await readFile(join(fixture.root, "microfrontends.json"))).toEqual(
      fixture.modified,
    );
    expect(
      await readFile(join(fixture.root, "apps/example/new file.sh")),
    ).toEqual(fixture.added);
    await expect(
      (await import("node:fs/promises"))
        .stat(join(fixture.root, "apps/example/new file.sh"))
        .then((stat) => stat.mode & 0o777),
    ).resolves.toBe(0o755);
    await expect(
      readFile(join(fixture.root, "obsolete.txt")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(git(fixture.root, ["diff", "--cached", "--binary"])).toBe(
      beforeIndex,
    );
    expect(
      git(fixture.root, ["diff", "--binary", "--", "unrelated-unstaged.txt"]),
    ).toBe(beforeWorktree);
    expect(
      await readFile(join(fixture.root, "untracked with spaces.txt"), "utf8"),
    ).toBe("untracked next\n");
    expect(git(fixture.root, ["rev-parse", "HEAD"])).toBe(
      `${fixture.source.sourceSha}\n`,
    );
    await verifyPublishedChangeSet({
      receipt: result.receipt,
      sourceReceipt: fixture.source,
      review: fixture.review,
    });
  }, 15_000);

  it("rejects a recomputed success receipt with a forged postcondition", async () => {
    const fixture = await combinedFixture();
    const proposal = await deriveLocalPublicationProposal({
      destinationPath: fixture.root,
      sourceReceipt: fixture.source,
      review: fixture.review,
    });
    const result = await publishReviewedChangeSet({
      proposal,
      sourceReceipt: fixture.source,
      review: fixture.review,
      publishedByCallId: "forged-postcondition",
      readOverlayFile: async (path) => fixture.overlay.get(path) ?? null,
    });
    if (!result.ok) throw new Error(result.receipt.failureMessage);
    const forged = {
      ...result.receipt,
      postconditionDigest: "0".repeat(64),
      digest: "",
    };
    forged.digest = receiptDigest(forged);
    await expect(
      verifyPublishedChangeSet({
        receipt: forged,
        sourceReceipt: fixture.source,
        review: fixture.review,
      }),
    ).rejects.toThrow(/success.*not canonical/u);
  });

  it("requires published workflow reuse to match the exact durable success", async () => {
    const fixture = await combinedFixture();
    const proposal = await deriveLocalPublicationProposal({
      destinationPath: fixture.root,
      sourceReceipt: fixture.source,
      review: fixture.review,
    });
    const result = await publishReviewedChangeSet({
      proposal,
      sourceReceipt: fixture.source,
      review: fixture.review,
      publishedByCallId: "published-reuse",
      readOverlayFile: async (path) => fixture.overlay.get(path) ?? null,
    });
    if (!result.ok) throw new Error(result.receipt.failureMessage);
    const durable = await readLocalPublicationJournal(fixture.root);
    expect(() =>
      assertExactDurablePublicationSuccess(result.receipt, durable),
    ).not.toThrow();
    expect(() =>
      assertExactDurablePublicationSuccess(result.receipt, undefined),
    ).toThrow(/durable success journal/u);
    for (const status of ["pending", "failed"] as const) {
      const wrongStatus = {
        ...result.receipt,
        status,
      } as unknown as LocalPublicationJournal;
      expect(() =>
        assertExactDurablePublicationSuccess(result.receipt, wrongStatus),
      ).toThrow(/durable success journal/u);
    }
    const differentSuccess = {
      ...result.receipt,
      publishedByCallId: "different-call",
      digest: "",
    };
    differentSuccess.digest = receiptDigest(differentSuccess);
    expect(() =>
      assertExactDurablePublicationSuccess(result.receipt, differentSuccess),
    ).toThrow(/exactly match/u);
  });

  it.each([
    "appliedPaths",
    "intentPaths",
    "rolledBackPaths",
    "conflictedPaths",
    "uncertainPaths",
    "recoveryRequired",
    "pathEvidence",
  ] as const)(
    "rejects a digest-valid success with forged %s",
    async (field) => {
      const fixture = await combinedFixture();
      const proposal = await deriveLocalPublicationProposal({
        destinationPath: fixture.root,
        sourceReceipt: fixture.source,
        review: fixture.review,
      });
      const result = await publishReviewedChangeSet({
        proposal,
        sourceReceipt: fixture.source,
        review: fixture.review,
        publishedByCallId: `forged-${field}`,
        readOverlayFile: async (path) => fixture.overlay.get(path) ?? null,
      });
      if (!result.ok) throw new Error(result.receipt.failureMessage);
      const forged = { ...result.receipt, digest: "" };
      if (field === "appliedPaths") forged.appliedPaths = [];
      if (field === "intentPaths") forged.intentPaths = [];
      if (field === "rolledBackPaths")
        forged.rolledBackPaths = [proposal.executionPaths[0]!];
      if (field === "conflictedPaths")
        forged.conflictedPaths = [proposal.executionPaths[0]!];
      if (field === "uncertainPaths")
        forged.uncertainPaths = [proposal.executionPaths[0]!];
      if (field === "recoveryRequired") forged.recoveryRequired = true;
      if (field === "pathEvidence") forged.pathEvidence = [];
      forged.digest = receiptDigest(forged);
      expect(() => assertCanonicalLocalPublicationJournal(forged)).toThrow(
        /not canonical/u,
      );
    },
    15_000,
  );

  it.each(["staged", "unstaged", "deleted", "untracked", "rename"] as const)(
    "rejects %s overlap",
    async (kind) => {
      const { root, source } = await fixtureRoot();
      const path = "microfrontends.json";
      const { review } = await reviewFor(root, source, {
        [path]: { kind: "modified", bytes: Buffer.from("next\n") },
      });
      if (kind === "staged") {
        await writeFile(join(root, path), "dirty\n");
        git(root, ["add", "--", path]);
      }
      if (kind === "unstaged") await writeFile(join(root, path), "dirty\n");
      if (kind === "deleted")
        await (await import("node:fs/promises")).unlink(join(root, path));
      if (kind === "untracked") {
        git(root, ["rm", "--cached", "--", path]);
      }
      if (kind === "rename")
        git(root, ["mv", "--", path, "renamed with spaces.json"]);
      await expect(
        deriveLocalPublicationProposal({
          destinationPath: root,
          sourceReceipt: source,
          review,
        }),
      ).rejects.toThrow(/dirty overlap/u);
    },
  );

  it.each(["leaf", "parent"] as const)(
    "rejects a %s symlink in an approved path",
    async (kind) => {
      const { root, source } = await fixtureRoot();
      const approved =
        kind === "leaf" ? "symlink.txt" : "apps/symlink-parent/new.txt";
      const { review } = await reviewFor(root, source, {
        [approved]: { kind: "added", bytes: Buffer.from("next\n") },
      });
      if (kind === "leaf") await symlink("/tmp", join(root, approved));
      else {
        await mkdir(join(root, "apps"), { recursive: true });
        await symlink("/tmp", join(root, "apps/symlink-parent"));
      }
      await expect(
        deriveLocalPublicationProposal({
          destinationPath: root,
          sourceReceipt: source,
          review,
        }),
      ).rejects.toThrow(/dirty overlap|symlink/u);
    },
  );

  it("rejects a symlink alias for the destination root", async () => {
    const { root, source } = await fixtureRoot();
    const alias = `${root}-alias`;
    await symlink(root, alias);
    const { review } = await reviewFor(root, source, {
      "new.txt": { kind: "added", bytes: Buffer.from("next\n") },
    });
    await expect(
      deriveLocalPublicationProposal({
        destinationPath: alias,
        sourceReceipt: source,
        review,
      }),
    ).rejects.toThrow("canonical original source path");
  });

  it.each([0, 1, 2])(
    "rolls back completely after a failure following write %i",
    async (failureIndex) => {
      const fixture = await combinedFixture();
      const original = await readFile(
        join(fixture.root, "microfrontends.json"),
      );
      const proposal = await deriveLocalPublicationProposal({
        destinationPath: fixture.root,
        sourceReceipt: fixture.source,
        review: fixture.review,
      });
      const result = await publishReviewedChangeSet({
        proposal,
        sourceReceipt: fixture.source,
        review: fixture.review,
        publishedByCallId: `failure-${failureIndex}`,
        readOverlayFile: async (path) => fixture.overlay.get(path) ?? null,
        hooks: {
          afterMutation: (_path, index) => {
            if (index === failureIndex) throw new Error("injected failure");
          },
        },
      });
      expect(result).toMatchObject({
        ok: false,
        receipt: { recoveryRequired: false, conflictedPaths: [] },
      });
      expect(await readFile(join(fixture.root, "microfrontends.json"))).toEqual(
        original,
      );
      expect(await readFile(join(fixture.root, "obsolete.txt"), "utf8")).toBe(
        "remove me\n",
      );
      await expect(
        readFile(join(fixture.root, "apps/example/new file.sh")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.each([0, 1, 3])(
    "canonically journals an uncertain Git failure with %i observed postimages",
    async (postimageCount) => {
      const fixture = await combinedFixture();
      const proposal = await deriveLocalPublicationProposal({
        destinationPath: fixture.root,
        sourceReceipt: fixture.source,
        review: fixture.review,
      });
      const result = await publishReviewedChangeSet({
        proposal,
        sourceReceipt: fixture.source,
        review: fixture.review,
        publishedByCallId: `uncertain-git-${postimageCount}`,
        readOverlayFile: async (path) => fixture.overlay.get(path) ?? null,
        hooks: {
          dispatchGitApply: async () => {
            await materializeApprovedPostimages(
              fixture.root,
              proposal,
              fixture.overlay,
              postimageCount,
            );
            throw new Error("injected mutating Git apply failure");
          },
        },
      });
      if (result.ok) throw new Error("expected uncertain Git failure");
      expect(result.receipt).toMatchObject({
        status: "failed",
        reason: "mutation-failed",
        appliedPaths: proposal.executionPaths.slice(0, postimageCount),
        rolledBackPaths: proposal.executionPaths.slice(0, postimageCount),
        conflictedPaths: [],
        recoveryRequired: false,
      });
      assertCanonicalLocalPublicationJournal(result.receipt);
      const durable = await readLocalPublicationJournal(fixture.root);
      expect(durable).toEqual(result.receipt);
      if (durable === undefined)
        throw new Error("expected durable uncertain-dispatch failure");
      assertCanonicalLocalPublicationJournal(durable);
    },
  );

  it.each(["unexpected-bytes", "symlink", "read-failure"] as const)(
    "durably records %s as uncertain after a thrown Git dispatch",
    async (kind) => {
      const fixture = await combinedFixture();
      const proposal = await deriveLocalPublicationProposal({
        destinationPath: fixture.root,
        sourceReceipt: fixture.source,
        review: fixture.review,
      });
      const path = proposal.executionPaths.find(
        (candidate) =>
          proposal.changes.find((change) => change.path === candidate)
            ?.before === undefined,
      )!;
      const target = join(fixture.root, path);
      const outside = await mkdtemp(`${fixture.root}-uncertain-outside-`);
      const sentinel = join(outside, "sentinel.txt");
      await writeFile(sentinel, "outside-user-state\n");
      const result = await publishReviewedChangeSet({
        proposal,
        sourceReceipt: fixture.source,
        review: fixture.review,
        publishedByCallId: `uncertain-${kind}`,
        readOverlayFile: async (candidate) =>
          fixture.overlay.get(candidate) ?? null,
        hooks: {
          dispatchGitApply: async () => {
            await mkdir(dirname(target), { recursive: true });
            if (kind === "unexpected-bytes")
              await writeFile(target, "user-owned-unexpected-bytes\n");
            if (kind === "symlink") await symlink(sentinel, target);
            throw new Error("injected uncertain mutating Git failure");
          },
          beforeUncertainClassification: (candidate) => {
            if (kind === "read-failure" && candidate === path)
              throw new Error("injected classification read failure");
          },
        },
      });
      if (result.ok) throw new Error("expected uncertain publication failure");
      expect(result.receipt).toMatchObject({
        status: "failed",
        reason: "rollback-conflict",
        appliedPaths: [],
        rolledBackPaths: [],
        conflictedPaths: [],
        uncertainPaths: [path],
        recoveryRequired: true,
      });
      assertCanonicalLocalPublicationJournal(result.receipt);
      const durable = await readLocalPublicationJournal(fixture.root);
      expect(durable).toEqual(result.receipt);
      if (durable === undefined)
        throw new Error("expected durable uncertainty evidence");
      assertCanonicalLocalPublicationJournal(durable);
      expect(await readFile(sentinel, "utf8")).toBe("outside-user-state\n");
      if (kind === "unexpected-bytes")
        expect(await readFile(target, "utf8")).toBe(
          "user-owned-unexpected-bytes\n",
        );
      if (kind === "symlink")
        expect(
          (
            await (await import("node:fs/promises")).lstat(target)
          ).isSymbolicLink(),
        ).toBe(true);
      if (kind === "read-failure")
        await expect(readFile(target)).rejects.toMatchObject({
          code: "ENOENT",
        });
    },
  );

  it("does not overwrite a concurrent post-write edit during rollback", async () => {
    const { root, source } = await fixtureRoot();
    const path = "microfrontends.json";
    const next = Buffer.from("next\n");
    const { review, overlay } = await reviewFor(root, source, {
      [path]: { kind: "modified", bytes: next },
    });
    const proposal = await deriveLocalPublicationProposal({
      destinationPath: root,
      sourceReceipt: source,
      review,
    });
    let changed = false;
    const result = await publishReviewedChangeSet({
      proposal,
      sourceReceipt: source,
      review,
      publishedByCallId: "conflict",
      readOverlayFile: async (candidate) => overlay.get(candidate) ?? null,
      hooks: {
        afterMutation: () => {
          throw new Error("trigger rollback");
        },
        beforeRollback: async () => {
          if (!changed) {
            changed = true;
            await writeFile(join(root, path), "concurrent\n");
          }
        },
      },
    });
    expect(result).toMatchObject({
      ok: false,
      receipt: { recoveryRequired: true, conflictedPaths: [path] },
    });
    expect(await readFile(join(root, path), "utf8")).toBe("concurrent\n");
  });

  it("rolls back after an exception reported after the atomic Git mutation", async () => {
    const fixture = await combinedFixture();
    const proposal = await deriveLocalPublicationProposal({
      destinationPath: fixture.root,
      sourceReceipt: fixture.source,
      review: fixture.review,
    });
    const result = await publishReviewedChangeSet({
      proposal,
      sourceReceipt: fixture.source,
      review: fixture.review,
      publishedByCallId: "post-git-fsync-failure",
      readOverlayFile: async (path) => fixture.overlay.get(path) ?? null,
      hooks: {
        afterGitApply: () => {
          throw new Error("injected directory fsync failure after mutation");
        },
      },
    });
    expect(result).toMatchObject({
      ok: false,
      receipt: {
        intentPaths: proposal.executionPaths,
        appliedPaths: proposal.executionPaths,
        rolledBackPaths: proposal.executionPaths,
        recoveryRequired: false,
      },
    });
  });

  it("rejects a parent symlink swap before Git dispatch without touching an outside sentinel", async () => {
    const { root, source } = await fixtureRoot();
    const path = ".config/mise/new.txt";
    const { review, overlay } = await reviewFor(root, source, {
      [path]: { kind: "added", bytes: Buffer.from("inside\n") },
    });
    const proposal = await deriveLocalPublicationProposal({
      destinationPath: root,
      sourceReceipt: source,
      review,
    });
    const outside = await mkdtemp(`${root}-outside-`);
    const sentinel = join(outside, "sentinel.txt");
    await writeFile(sentinel, "outside sentinel\n");
    const originalParent = join(root, ".config/mise-original");
    const parent = join(root, ".config/mise");
    const result = await publishReviewedChangeSet({
      proposal,
      sourceReceipt: source,
      review,
      publishedByCallId: "parent-symlink-swap",
      readOverlayFile: async (candidate) => overlay.get(candidate) ?? null,
      hooks: {
        beforeGitApply: async () => {
          await rename(parent, originalParent);
          await symlink(outside, parent);
        },
      },
    });
    expect(result).toMatchObject({
      ok: false,
      receipt: { appliedPaths: [], recoveryRequired: false },
    });
    expect(await readFile(sentinel, "utf8")).toBe("outside sentinel\n");
    await expect(readFile(join(outside, "new.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await unlink(parent);
    await rename(originalParent, parent);
    await rm(outside, { recursive: true, force: true });
  });

  it("rejects approved-path drift immediately before its write and preserves the concurrent bytes", async () => {
    const { root, source } = await fixtureRoot();
    const path = "microfrontends.json";
    const { review, overlay } = await reviewFor(root, source, {
      [path]: { kind: "modified", bytes: Buffer.from("next\n") },
    });
    const proposal = await deriveLocalPublicationProposal({
      destinationPath: root,
      sourceReceipt: source,
      review,
    });
    const result = await publishReviewedChangeSet({
      proposal,
      sourceReceipt: source,
      review,
      publishedByCallId: "pre-write-drift",
      readOverlayFile: async (candidate) => overlay.get(candidate) ?? null,
      hooks: {
        beforeMutation: async () => {
          await writeFile(join(root, path), "concurrent-before-write\n");
        },
      },
    });
    expect(result).toMatchObject({
      ok: false,
      receipt: { appliedPaths: [], recoveryRequired: false },
    });
    expect(await readFile(join(root, path), "utf8")).toBe(
      "concurrent-before-write\n",
    );
  });

  it("rejects unrelated drift during publication and rolls back approved paths", async () => {
    const fixture = await combinedFixture();
    const unrelated = join(fixture.root, "unrelated-unstaged.txt");
    const proposal = await deriveLocalPublicationProposal({
      destinationPath: fixture.root,
      sourceReceipt: fixture.source,
      review: fixture.review,
    });
    let wrote = false;
    const result = await publishReviewedChangeSet({
      proposal,
      sourceReceipt: fixture.source,
      review: fixture.review,
      publishedByCallId: "unrelated-drift",
      readOverlayFile: async (path) => fixture.overlay.get(path) ?? null,
      hooks: {
        afterMutation: async () => {
          if (!wrote) {
            wrote = true;
            await writeFile(unrelated, "concurrent unrelated\n");
          }
        },
      },
    });
    expect(result).toMatchObject({
      ok: false,
      receipt: { recoveryRequired: false },
    });
    expect(await readFile(unrelated, "utf8")).toBe("concurrent unrelated\n");
  });

  it("supports linked worktrees without assuming .git is a directory", async () => {
    const original = await fixtureRoot();
    const linkedPath = `${original.root}-linked`;
    git(original.root, [
      "worktree",
      "add",
      "-b",
      "publication-linked",
      linkedPath,
      "HEAD",
    ]);
    const source = await inspectSourceReceipt(
      "existing-repository",
      linkedPath,
    );
    const path = "microfrontends.json";
    const next = Buffer.from("linked worktree\n");
    const { review, overlay } = await reviewFor(source.sourcePath, source, {
      [path]: { kind: "modified", bytes: next },
    });
    const proposal = await deriveLocalPublicationProposal({
      destinationPath: source.sourcePath,
      sourceReceipt: source,
      review,
    });
    const result = await publishReviewedChangeSet({
      proposal,
      sourceReceipt: source,
      review,
      publishedByCallId: "linked-worktree",
      readOverlayFile: async (candidate) => overlay.get(candidate) ?? null,
    });
    expect(result).toMatchObject({ ok: true });
    expect(await readFile(join(source.sourcePath, path))).toEqual(next);
  });

  it("rejects an oversized postimage before pending or destination mutation", async () => {
    const { root, source } = await fixtureRoot();
    const bytes = Buffer.alloc(4 * 1024 * 1024 + 1, 1);
    const { review } = await reviewFor(root, source, {
      "oversized.bin": { kind: "added", bytes },
    });
    const proposal = await deriveLocalPublicationProposal({
      destinationPath: root,
      sourceReceipt: source,
      review,
    });
    const result = await publishReviewedChangeSet({
      proposal,
      sourceReceipt: source,
      review,
      publishedByCallId: "oversized",
      readOverlayFile: async () => bytes,
    });
    expect(result).toMatchObject({
      ok: false,
      receipt: { reason: "precondition-failed", appliedPaths: [] },
    });
    await expect(readFile(join(root, "oversized.bin"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects capability absence before acquiring a lock or writing", async () => {
    const fixture = await combinedFixture();
    const proposal = await deriveLocalPublicationProposal({
      destinationPath: fixture.root,
      sourceReceipt: fixture.source,
      review: fixture.review,
    });
    vi.stubEnv("APP_BUILDER_LOCAL_PUBLICATION", "0");
    await expect(
      publishReviewedChangeSet({
        proposal,
        sourceReceipt: fixture.source,
        review: fixture.review,
        publishedByCallId: "disabled",
        readOverlayFile: async (path) => fixture.overlay.get(path) ?? null,
      }),
    ).rejects.toThrow("Local publication is disabled");
    expect(git(fixture.root, ["status", "--porcelain"])).toBe("");
  });

  it("never automatically retries a durable pending attempt", async () => {
    const fixture = await combinedFixture();
    const proposal = await deriveLocalPublicationProposal({
      destinationPath: fixture.root,
      sourceReceipt: fixture.source,
      review: fixture.review,
    });
    const { digest: proposalDigest, ...proposalFields } = proposal;
    const unsigned = {
      ...proposalFields,
      proposalDigest,
      status: "pending" as const,
      publishedByCallId: "interrupted-call",
      beforeStatusDigest: proposal.preconditionStatusDigest,
      appliedPaths: [] as readonly string[],
      intentPaths: proposal.executionPaths,
      pathEvidence: proposal.changes.map((change) => ({
        path: change.path,
        operation: change.kind,
        ...(change.before === undefined ? {} : { before: change.before }),
        ...(change.after === undefined ? {} : { after: change.after }),
      })),
    };
    const pending: LocalPublicationPendingReceipt = {
      ...unsigned,
      digest: hash(unsigned),
    };
    expect(receiptDigest(pending)).toBe(pending.digest);
    const forgedPending = {
      ...pending,
      appliedPaths: [proposal.executionPaths[0]!],
      digest: "",
    };
    forgedPending.digest = receiptDigest(forgedPending);
    expect(() => assertCanonicalLocalPublicationJournal(forgedPending)).toThrow(
      /pending.*not canonical/u,
    );
    const journalPath = git(fixture.root, [
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "app-builder/local-publication.json",
    ]).trim();
    await mkdir(dirname(journalPath), { recursive: true });
    await writeFile(journalPath, `${JSON.stringify(pending)}\n`);
    const result = await publishReviewedChangeSet({
      proposal,
      sourceReceipt: fixture.source,
      review: fixture.review,
      publishedByCallId: "retry-call",
      readOverlayFile: async (path) => fixture.overlay.get(path) ?? null,
    });
    expect(result).toMatchObject({
      ok: false,
      receipt: { reason: "precondition-failed", appliedPaths: [] },
    });
    if (result.ok) throw new Error("expected fail-closed pending denial");
    expect(result.receipt.failureMessage).toContain(
      "automatic retry is disabled",
    );
  });

  it("never automatically retries a durable failed attempt", async () => {
    const fixture = await combinedFixture();
    const proposal = await deriveLocalPublicationProposal({
      destinationPath: fixture.root,
      sourceReceipt: fixture.source,
      review: fixture.review,
    });
    const first = await publishReviewedChangeSet({
      proposal,
      sourceReceipt: fixture.source,
      review: fixture.review,
      publishedByCallId: "failed-call",
      readOverlayFile: async (path) => fixture.overlay.get(path) ?? null,
      hooks: {
        afterMutation: () => {
          throw new Error("injected failure");
        },
      },
    });
    expect(first).toMatchObject({ ok: false, receipt: { status: "failed" } });
    if (first.ok) throw new Error("expected injected publication failure");
    const forgedFailure = {
      ...first.receipt,
      recoveryRequired: !first.receipt.recoveryRequired,
      digest: "",
    };
    forgedFailure.digest = receiptDigest(forgedFailure);
    expect(() => assertCanonicalLocalPublicationJournal(forgedFailure)).toThrow(
      /failed.*not canonical/u,
    );
    for (const forged of [
      {
        ...first.receipt,
        appliedPaths: [
          ...first.receipt.appliedPaths,
          ...first.receipt.appliedPaths.slice(0, 1),
        ],
      },
      {
        ...first.receipt,
        rolledBackPaths: [...first.receipt.rolledBackPaths].reverse(),
      },
      {
        ...first.receipt,
        reason:
          first.receipt.reason === "mutation-failed"
            ? ("rollback-conflict" as const)
            : ("mutation-failed" as const),
      },
      {
        ...first.receipt,
        reason: "unsupported-runtime-reason" as never,
      },
    ]) {
      const digestValid = { ...forged, digest: "" };
      digestValid.digest = receiptDigest(digestValid);
      expect(() => assertCanonicalLocalPublicationJournal(digestValid)).toThrow(
        /not canonical/u,
      );
    }
    const second = await publishReviewedChangeSet({
      proposal,
      sourceReceipt: fixture.source,
      review: fixture.review,
      publishedByCallId: "retry-call",
      readOverlayFile: async (path) => fixture.overlay.get(path) ?? null,
    });
    expect(second).toMatchObject({
      ok: false,
      receipt: { reason: "precondition-failed", appliedPaths: [] },
    });
    if (second.ok) throw new Error("expected fail-closed failed denial");
    expect(second.receipt.failureMessage).toContain(
      "automatic retry is disabled",
    );
  });

  it("leaves the durable pending authority when both terminal journal writes fail", async () => {
    const fixture = await combinedFixture();
    const original = await readFile(join(fixture.root, "microfrontends.json"));
    const proposal = await deriveLocalPublicationProposal({
      destinationPath: fixture.root,
      sourceReceipt: fixture.source,
      review: fixture.review,
    });
    await expect(
      publishReviewedChangeSet({
        proposal,
        sourceReceipt: fixture.source,
        review: fixture.review,
        publishedByCallId: "terminal-write-failure",
        readOverlayFile: async (path) => fixture.overlay.get(path) ?? null,
        hooks: {
          beforeTerminalJournalWrite: (status) => {
            throw new Error(`injected ${status} journal persistence failure`);
          },
        },
      }),
    ).rejects.toThrow("injected failed journal persistence failure");
    expect(await readLocalPublicationJournal(fixture.root)).toMatchObject({
      status: "pending",
      publishedByCallId: "terminal-write-failure",
    });
    expect(await readFile(join(fixture.root, "microfrontends.json"))).toEqual(
      original,
    );
  });

  it("rejects unsupported executable modes in the outer reviewed receipt", async () => {
    const { root, source } = await fixtureRoot();
    const reviewed = await reviewFor(root, source, {
      "new.txt": { kind: "added", bytes: Buffer.from("next\n") },
    });
    const malformed = structuredClone(reviewed.review);
    malformed.changes[0]!.after!.mode = "600";
    await expect(
      deriveLocalPublicationProposal({
        destinationPath: root,
        sourceReceipt: source,
        review: malformed,
      }),
    ).rejects.toThrow("unsupported file mode");
  });
});
