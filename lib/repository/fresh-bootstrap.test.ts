import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SUPPORTED_TEMPLATE_WORKFLOW_FIXTURE } from "../../evals/support/supported-repository";

import { contentDigest, stableDigest } from "./local-publication";
import {
  canonicalFreshBootstrapHelperPath,
  deriveFreshBootstrapProposal,
  publishFreshBootstrap,
  readFreshBootstrapJournal,
  recoverFreshBootstrap,
  verifyFreshBootstrap,
} from "./node-fresh-bootstrap";
import { createReviewedChangeSetReceipt } from "./reviewed-change-set";
import { inspectSourceReceipt } from "./source-receipt";
import {
  assertCanonicalFreshBootstrapJournal,
  assertExactFreshBootstrapProposal,
  gitTreeId,
  type FreshBootstrapCapability,
  type ExecutableIdentity,
  type PathIdentity,
} from "./fresh-bootstrap";

const roots: string[] = [];
vi.setConfig({ testTimeout: 30_000, hookTimeout: 20_000 });
beforeEach(() => vi.stubEnv("APP_BUILDER_TEST_MODEL", "1"));
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function pathIdentity(path: string): Promise<PathIdentity> {
  const canonical = await realpath(path);
  const value = await lstat(canonical);
  return {
    path: canonical,
    device: String(value.dev),
    inode: String(value.ino),
    uid: String(value.uid),
    mode: (value.mode & 0o777).toString(8),
    nlink: String(value.nlink),
  };
}

async function executableIdentity(path: string): Promise<ExecutableIdentity> {
  return {
    ...(await pathIdentity(path)),
    sha256: createHash("sha256")
      .update(await readFile(path))
      .digest("hex"),
  };
}

async function createTestSource(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "app-builder-bootstrap-source-"));
  roots.push(root);
  const files: Record<string, string> = {
    ".config/mise/config.toml": `[tasks."create:app"]\nrun = 'mise exec -- bun create --proposal "$usage_proposal"'\n[tasks."repository:preflight"]\nrun = "mise run repository:exec -- repository-preflight.ts"\n[tasks."generate:app"]\nrun = 'turbo gen --config .config/turbo/generators/config.ts app --args "$usage_app_id"'\n[tasks."app:check-build"]\nrun = 'bun .config/mise/scripts/repository/app-validation.ts check-build "$usage_app"'\n[tasks."app:test"]\nrun = 'bun .config/mise/scripts/repository/app-validation.ts test "$usage_app" "$usage_shard"'\n`,
    ".github/workflows/cd.yml": SUPPORTED_TEMPLATE_WORKFLOW_FIXTURE,
    ".config/mise/scripts/repository/app-contract.ts":
      'const source = { runtime: "nextjs" };\n',
    ".config/mise/scripts/repository/app-identity.ts":
      'const scope = "@autograph/${appId}";\n',
    ".config/mise/scripts/repository/app-validation.ts": "export {};\n",
    ".config/mise/scripts/repository/repository-preflight.ts":
      'const observed = { runtime: "nextjs" };\nconst a = "mise run repository:exec -- app-identity.ts --app <app-id>";\nconst b = "mise run repository:exec -- app-contract.ts --contract <contract-file>";\nconst c = "mise run create:app -- --proposal <proposal-file>";\nconst d = "mise run repository:preflight";\nconst e = ["mise run app:check-build <app-id>", "mise run app:test <app-id> <shard>"];\n',
    ".config/turbo/generators/config.ts": 'const scope = "autograph";\n',
    ".config/turbo/generators/create-app.ts": "export {};\n",
    ".config/turbo/generators/templates/app/next.config.ts.hbs":
      "export default {};\n",
    "microfrontends.json": "{}\n",
  };
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  const git = existsSync("/usr/bin/git") ? "/usr/bin/git" : "/bin/git";
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: "test",
    PATH: "/usr/bin:/bin",
    HOME: "/dev/null",
    XDG_CONFIG_HOME: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
  };
  execFileSync(git, ["init", "-b", "main"], { cwd: root, env });
  execFileSync(git, ["add", "--", ...Object.keys(files)], { cwd: root, env });
  execFileSync(
    git,
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "fixture",
    ],
    { cwd: root, env },
  );
  return root;
}

async function fixture(
  expectedPrestate: "absent" | "empty-directory",
  lockSelection?: {
    strategy: FreshBootstrapCapability["lockStrategy"];
    path: string;
  },
) {
  const sourceRoot = await createTestSource();
  const source = await inspectSourceReceipt("fresh-template", sourceRoot);
  const changedPath = "microfrontends.json";
  const beforeBytes = Buffer.from("{}\n");
  const afterBytes = Buffer.from('{"apps":[]}\n');
  const changes = [
    {
      path: changedPath,
      kind: "modified" as const,
      before: { mode: "644", digest: contentDigest(beforeBytes) },
      after: { mode: "644", digest: contentDigest(afterBytes) },
    },
  ];
  const changeSetUnsigned = {
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
    postTreeDigest: "7".repeat(64),
    changedContentDigest: stableDigest(changes),
    changes,
    approvedPaths: [changedPath],
  };
  const changeSet = {
    ...changeSetUnsigned,
    digest: stableDigest(changeSetUnsigned),
  };
  const review = createReviewedChangeSetReceipt(changeSet, "review-call");
  const owner = await realpath(
    await mkdtemp(join(tmpdir(), "app-builder-bootstrap-test-")),
  );
  roots.push(owner);
  await chmod(owner, 0o700);
  const stateRoot = join(owner, "state");
  const allowedRoot = join(owner, "destinations");
  await mkdir(stateRoot, { mode: 0o700 });
  await mkdir(allowedRoot, { mode: 0o700 });
  const destinationPath = join(allowedRoot, "new-repository");
  if (expectedPrestate === "empty-directory")
    await mkdir(destinationPath, { mode: 0o700 });
  const systemGit = await realpath(
    existsSync("/usr/bin/git") ? "/usr/bin/git" : "/bin/git",
  );
  const systemPython = await realpath(
    existsSync("/usr/bin/python3") ? "/usr/bin/python3" : "/bin/python3",
  );
  const selectedLock =
    lockSelection ??
    (existsSync("/usr/bin/flock")
      ? ({ strategy: "flock", path: "/usr/bin/flock" } as const)
      : ({ strategy: "lockf", path: "/usr/bin/lockf" } as const));
  const lockHelper = await realpath(selectedLock.path);
  const systemNode = await realpath(process.execPath);
  const capability: FreshBootstrapCapability = {
    kind: "fresh-bootstrap-local-v1",
    stateRoot: await pathIdentity(stateRoot),
    allowedRoot: await pathIdentity(allowedRoot),
    systemGit,
    systemPython,
    systemGitIdentity: await executableIdentity(systemGit),
    systemPythonIdentity: await executableIdentity(systemPython),
    systemNode,
    systemNodeIdentity: await executableIdentity(systemNode),
    lockStrategy: selectedLock.strategy,
    lockHelper,
    lockHelperIdentity: await executableIdentity(lockHelper),
    authority: "structural-test-injection",
  };
  const readOverlayFile = async (path: string) =>
    path === changedPath ? afterBytes : null;
  const proposal = await deriveFreshBootstrapProposal({
    capability,
    destinationPath,
    expectedPrestate,
    repositoryIdentity: {
      initialBranch: "main",
      authorName: "Autograph App Builder",
      authorEmail: "app-builder@users.noreply.github.com",
      commitMessage: "Bootstrap repository",
      commitTimestamp: "2026-08-25T12:00:00-04:00",
    },
    sourceReceipt: source,
    review,
    protectedPaths: [],
    readOverlayFile,
  });
  return {
    sourceRoot,
    sourceReceipt: source,
    review,
    owner,
    capability,
    destinationPath,
    proposal,
    readOverlayFile,
  };
}

it("canonicalizes selected git, python, and lock helper symlinks", async () => {
  const owner = await mkdtemp(join(tmpdir(), "app-builder-helper-links-"));
  roots.push(owner);
  const executable = join(owner, "helper-executable");
  await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const canonical = await realpath(executable);

  for (const name of ["git", "python3", "flock"]) {
    const selected = join(owner, name);
    await symlink(executable, selected);
    await expect(canonicalFreshBootstrapHelperPath(selected)).resolves.toBe(
      canonical,
    );
  }
});

async function lockStrategyWrapper(
  strategy: FreshBootstrapCapability["lockStrategy"],
): Promise<string> {
  const owner = await mkdtemp(join(tmpdir(), `app-builder-${strategy}-link-`));
  roots.push(owner);
  const executable = join(owner, "canonical-lock-helper");
  const nativeFlock = existsSync("/usr/bin/flock")
    ? "/usr/bin/flock"
    : undefined;
  const nativeLockf = existsSync("/usr/bin/lockf")
    ? "/usr/bin/lockf"
    : undefined;
  if (nativeFlock === undefined && nativeLockf === undefined)
    throw new Error("A native lock helper is required for this test.");
  const body =
    strategy === "flock"
      ? nativeFlock !== undefined
        ? `exec ${nativeFlock} "$@"\n`
        : `test "$1" = "-n"\nshift\nlock_path="$1"\nshift\nexec ${nativeLockf} -k -t 0 "$lock_path" "$@"\n`
      : nativeLockf !== undefined
        ? `exec ${nativeLockf} "$@"\n`
        : `test "$1" = "-k"\ntest "$2" = "-t"\ntest "$3" = "0"\nshift 3\nlock_path="$1"\nshift\nexec ${nativeFlock} -n "$lock_path" "$@"\n`;
  await writeFile(executable, `#!/bin/sh\nset -eu\n${body}`, { mode: 0o755 });
  const selected = join(owner, `selected-${strategy}`);
  await symlink(executable, selected);
  return selected;
}

it.each(["flock", "lockf"] as const)(
  "dispatches the bound %s strategy through a canonical helper and excludes a contender",
  async (strategy) => {
    const selected = await lockStrategyWrapper(strategy);
    const input = await fixture("absent", { strategy, path: selected });
    expect(input.capability.lockHelper).toMatch(/canonical-lock-helper$/u);
    expect(input.capability.lockStrategy).toBe(strategy);
    let signalReady!: () => void;
    let releaseFirst!: () => void;
    const ready = new Promise<void>((resolve) => (signalReady = resolve));
    const held = new Promise<void>((resolve) => (releaseFirst = resolve));
    const first = publishFreshBootstrap({
      ...input,
      publishedByCallId: `first-${strategy}`,
      hooks: {
        afterLockReady: async () => {
          signalReady();
          await held;
        },
      },
    });
    await ready;
    await expect(
      publishFreshBootstrap({
        ...input,
        publishedByCallId: `contender-${strategy}`,
      }),
    ).rejects.toThrow(/leased|lease/u);
    releaseFirst();
    await expect(first).resolves.toMatchObject({ ok: true });
  },
  40_000,
);

describe.each(["absent", "empty-directory"] as const)(
  "fresh local bootstrap from an %s destination",
  (expectedPrestate) => {
    it("publishes one exact parentless SHA-1 commit without remotes", async () => {
      const input = await fixture(expectedPrestate);
      const result = await publishFreshBootstrap({
        ...input,
        publishedByCallId: "publish-call",
      });
      if (!result.ok) throw new Error(result.receipt.failureMessage);
      expect(result).toMatchObject({ ok: true });
      expect(result.receipt.headCommit).toBe(
        input.proposal.expectedInitialCommit,
      );
      await verifyFreshBootstrap({ ...input, receipt: result.receipt });
      expect(
        await readFile(
          join(input.destinationPath, ".config/mise/config.toml"),
          "utf8",
        ),
      ).toContain("create:app");
      expect(existsSync(input.proposal.stagingPath)).toBe(
        expectedPrestate === "empty-directory",
      );
    });
  },
);

it("fails closed after a durable partial stage and recovers only by exact journal digest", async () => {
  const input = await fixture("absent");
  const failed = await publishFreshBootstrap({
    ...input,
    publishedByCallId: "publish-call",
    hooks: {
      afterMaterializeFile: () => {
        throw new Error("injected stop");
      },
    },
  });
  expect(failed.ok).toBe(false);
  if (failed.ok) return;
  await expect(
    recoverFreshBootstrap({
      ...input,
      publishedByCallId: "recover-call",
      expectedJournalDigest: "0".repeat(64),
    }),
  ).rejects.toThrow("exact journal digest");
  const recovered = await recoverFreshBootstrap({
    ...input,
    publishedByCallId: "recover-call",
    expectedJournalDigest: failed.receipt.digest,
  });
  expect(recovered.ok).toBe(true);
});

it("rejects disabled capability and hostile destination collision before mutation", async () => {
  const input = await fixture("absent");
  await expect(
    deriveFreshBootstrapProposal({
      ...input,
      capability: undefined,
      expectedPrestate: "absent",
      repositoryIdentity: input.proposal.repositoryIdentity,
      protectedPaths: [],
    }),
  ).rejects.toThrow("not configured");
  await mkdir(input.destinationPath, { mode: 0o700 });
  await expect(
    publishFreshBootstrap({ ...input, publishedByCallId: "publish-call" }),
  ).resolves.toMatchObject({ ok: false });
});

it("never overwrites a hostile creator racing absent atomic publication", async () => {
  const input = await fixture("absent");
  const result = await publishFreshBootstrap({
    ...input,
    publishedByCallId: "publish-call",
    hooks: {
      beforeAtomicPublication: () =>
        mkdir(input.destinationPath, { mode: 0o700 }),
    },
  });
  expect(result).toMatchObject({
    ok: false,
    receipt: { destinationPublished: false, recoveryRequired: true },
  });
  expect(await readdir(input.destinationPath)).toEqual([]);
});

it("never publishes a stage substituted after durable review", async () => {
  const input = await fixture("absent");
  const reviewedStage = `${input.proposal.stagingPath}.reviewed`;
  const result = await publishFreshBootstrap({
    ...input,
    publishedByCallId: "publish-call",
    hooks: {
      beforeAtomicPublication: async () => {
        await rename(input.proposal.stagingPath, reviewedStage);
        await mkdir(input.proposal.stagingPath, { mode: 0o700 });
        await writeFile(join(input.proposal.stagingPath, "unreviewed"), "x");
      },
    },
  });
  expect(result).toMatchObject({
    ok: false,
    receipt: { destinationPublished: false, recoveryRequired: true },
  });
  expect(existsSync(input.destinationPath)).toBe(false);
  expect(await readdir(input.proposal.stagingPath)).toEqual(["unreviewed"]);
  expect(existsSync(reviewedStage)).toBe(true);
});

it("never exchanges over a substituted exact-empty destination", async () => {
  const input = await fixture("empty-directory");
  const approvedEmpty = `${input.destinationPath}.approved`;
  const result = await publishFreshBootstrap({
    ...input,
    publishedByCallId: "publish-call",
    hooks: {
      beforeAtomicPublication: async () => {
        await rename(input.destinationPath, approvedEmpty);
        await mkdir(input.destinationPath, { mode: 0o700 });
      },
    },
  });
  expect(result).toMatchObject({
    ok: false,
    receipt: { destinationPublished: false, recoveryRequired: true },
  });
  expect(await readdir(input.destinationPath)).toEqual([]);
  expect(await readdir(approvedEmpty)).toEqual([]);
  expect(existsSync(input.proposal.stagingPath)).toBe(true);
});

it("recovers the exact swapped-empty layout and retains its bound tombstone", async () => {
  const input = await fixture("empty-directory");
  const failed = await publishFreshBootstrap({
    ...input,
    publishedByCallId: "publish-call",
    hooks: {
      afterAtomicSwap: () => {
        throw new Error("injected post-swap stop");
      },
    },
  });
  expect(failed).toMatchObject({
    ok: false,
    receipt: { destinationPublished: true },
  });
  if (failed.ok) return;
  expect(existsSync(input.proposal.stagingPath)).toBe(true);
  const recovered = await recoverFreshBootstrap({
    ...input,
    publishedByCallId: "recover-call",
    expectedJournalDigest: failed.receipt.digest,
  });
  if (!recovered.ok) throw new Error(recovered.receipt.failureMessage);
  expect(recovered).toMatchObject({ ok: true });
  expect(existsSync(input.proposal.stagingPath)).toBe(true);
  expect(await readdir(input.proposal.stagingPath)).toEqual([]);
});

it("reconciles lost response after atomic publication", async () => {
  const input = await fixture("absent");
  const failed = await publishFreshBootstrap({
    ...input,
    publishedByCallId: "publish-call",
    hooks: {
      afterAtomicPublication: () => {
        throw new Error("lost response");
      },
    },
  });
  expect(failed).toMatchObject({
    ok: false,
    receipt: { destinationPublished: true },
  });
  if (failed.ok) return;
  await expect(
    recoverFreshBootstrap({
      ...input,
      publishedByCallId: "recover-call",
      expectedJournalDigest: failed.receipt.digest,
    }),
  ).resolves.toMatchObject({ ok: true });
});

it("preserves an abnormal lease marker and blocks an immediate contender", async () => {
  const input = await fixture("absent");
  await expect(
    publishFreshBootstrap({
      ...input,
      publishedByCallId: "publish-call",
      hooks: {
        afterLockReady: async (pid) => {
          process.kill(pid, "SIGKILL");
          await new Promise((resolve) => setTimeout(resolve, 50));
        },
      },
    }),
  ).rejects.toThrow("lease was lost");
  const journal = await readFreshBootstrapJournal({
    capability: input.capability,
    proposal: input.proposal,
  });
  expect(journal).toBeUndefined();
  await expect(
    publishFreshBootstrap({
      ...input,
      publishedByCallId: "contender-call",
    }),
  ).rejects.toThrow(/leased|lease/u);
});

it("allows only exact journal-bound takeover after post-journal helper loss", async () => {
  const input = await fixture("absent");
  let holderPid = 0;
  const failed = await publishFreshBootstrap({
    ...input,
    publishedByCallId: "publish-call",
    hooks: {
      afterLockReady: (pid) => {
        holderPid = pid;
      },
      afterPendingJournal: async () => {
        process.kill(holderPid, "SIGKILL");
        await new Promise((resolve) => setTimeout(resolve, 50));
      },
    },
  });
  expect(failed).toMatchObject({
    ok: false,
    receipt: { status: "failed", recoveryRequired: true },
  });
  const journal = await readFreshBootstrapJournal({
    capability: input.capability,
    proposal: input.proposal,
  });
  expect(journal?.status).toBe("failed");
  await expect(
    recoverFreshBootstrap({
      ...input,
      publishedByCallId: "recover-call",
      expectedJournalDigest: journal!.digest,
    }),
  ).resolves.toMatchObject({ ok: true });
}, 15_000);

it("refuses ACTIVE takeover during Git, then permits exact QUIESCED recovery", async () => {
  const input = await fixture("absent");
  let holderPid = 0;
  const failed = await publishFreshBootstrap({
    ...input,
    publishedByCallId: "publish-call",
    hooks: {
      afterLockReady: (pid) => {
        holderPid = pid;
      },
      beforeGitAdd: async () => {
        process.kill(holderPid, "SIGKILL");
        await new Promise((resolve) => setTimeout(resolve, 50));
        const activeJournal = await readFreshBootstrapJournal({
          capability: input.capability,
          proposal: input.proposal,
        });
        await expect(
          recoverFreshBootstrap({
            ...input,
            publishedByCallId: "unsafe-concurrent-recover",
            expectedJournalDigest: activeJournal!.digest,
          }),
        ).rejects.toThrow(/leased|lease/u);
      },
    },
  });
  expect(failed).toMatchObject({
    ok: false,
    receipt: { status: "failed", recoveryRequired: true },
  });
  if (failed.ok) return;
  await expect(
    recoverFreshBootstrap({
      ...input,
      publishedByCallId: "safe-recover",
      expectedJournalDigest: failed.receipt.digest,
    }),
  ).resolves.toMatchObject({ ok: true });
}, 20_000);

it("rejects rehashed unknown keys plus reserved and prefix-colliding paths", async () => {
  const input = await fixture("absent");
  const candidate = { ...input.proposal, unknownAuthority: true } as Record<
    string,
    unknown
  >;
  delete candidate.digest;
  candidate.digest = stableDigest(candidate);
  expect(() => assertExactFreshBootstrapProposal(candidate as never)).toThrow(
    "canonical V3",
  );
  expect(() =>
    gitTreeId([{ path: ".git/config", mode: "100644", blob: "a".repeat(40) }]),
  ).toThrow("unsafe");
  expect(() =>
    gitTreeId([
      { path: "a", mode: "100644", blob: "a".repeat(40) },
      { path: "a/b", mode: "100644", blob: "b".repeat(40) },
    ]),
  ).toThrow("unsafe");
});

it("ignores hostile ambient Git, loader, proxy, HOME, XDG, and PATH authority", async () => {
  const input = await fixture("absent");
  for (const [name, value] of Object.entries({
    PATH: "/hostile",
    HOME: "/hostile",
    XDG_CONFIG_HOME: "/hostile",
    GIT_DIR: "/hostile",
    GIT_WORK_TREE: "/hostile",
    GIT_COMMON_DIR: "/hostile",
    GIT_OBJECT_DIRECTORY: "/hostile",
    GIT_ALTERNATE_OBJECT_DIRECTORIES: "/hostile",
    GIT_INDEX_FILE: "/hostile",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_PARAMETERS: "'user.name=Hostile'",
    GIT_NAMESPACE: "hostile",
    GIT_REPLACE_REF_BASE: "refs/hostile",
    GIT_SSH_COMMAND: "false",
    SSH_ASKPASS: "/hostile",
    HTTPS_PROXY: "http://hostile.invalid",
    DYLD_INSERT_LIBRARIES: "/hostile",
  }))
    vi.stubEnv(name, value);
  await expect(
    publishFreshBootstrap({ ...input, publishedByCallId: "publish-call" }),
  ).resolves.toMatchObject({ ok: true });
});

it("rejects source, root, and helper identity drift before mutation", async () => {
  const sourceDrift = await fixture("absent");
  await writeFile(join(sourceDrift.sourceRoot, "drift.txt"), "drift\n");
  await expect(
    publishFreshBootstrap({
      ...sourceDrift,
      publishedByCallId: "publish-call",
    }),
  ).rejects.toThrow(/source changed|Source is not eligible/u);

  const rootDrift = await fixture("absent");
  const moved = `${rootDrift.capability.allowedRoot.path}.moved`;
  await rename(rootDrift.capability.allowedRoot.path, moved);
  await symlink(moved, rootDrift.capability.allowedRoot.path);
  await expect(
    publishFreshBootstrap({ ...rootDrift, publishedByCallId: "publish-call" }),
  ).rejects.toThrow(/identity changed|not canonical/u);

  const helperDrift = await fixture("absent");
  const capability = structuredClone(helperDrift.capability);
  capability.systemGitIdentity.inode = "0";
  await expect(
    publishFreshBootstrap({
      ...helperDrift,
      capability,
      publishedByCallId: "publish-call",
    }),
  ).rejects.toThrow("helper identity changed");

  const strategyDrift = await fixture("absent");
  const changedStrategy = structuredClone(strategyDrift.capability);
  changedStrategy.lockStrategy =
    changedStrategy.lockStrategy === "flock" ? "lockf" : "flock";
  await expect(
    publishFreshBootstrap({
      ...strategyDrift,
      capability: changedStrategy,
      publishedByCallId: "publish-call",
    }),
  ).rejects.toThrow("exact fresh-bootstrap inputs changed");
});

it("keeps disabled recovery fail-closed after a durable pending attempt", async () => {
  const input = await fixture("absent");
  const failed = await publishFreshBootstrap({
    ...input,
    publishedByCallId: "publish-call",
    hooks: {
      afterStageCreation: () => {
        throw new Error("stop after durable stage");
      },
    },
  });
  expect(failed.ok).toBe(false);
  if (failed.ok) return;
  await expect(
    recoverFreshBootstrap({
      ...input,
      capability: undefined,
      publishedByCallId: "recover-call",
      expectedJournalDigest: failed.receipt.digest,
    }),
  ).rejects.toThrow("not configured");
});

it.each([
  "beforeGitInit",
  "afterGitInit",
  "beforeGitAdd",
  "afterGitAdd",
  "beforeGitCommit",
  "afterGitCommit",
] as const)("recovers an exact %s boundary failure", async (boundary) => {
  const input = await fixture("absent");
  const failed = await publishFreshBootstrap({
    ...input,
    publishedByCallId: "publish-call",
    hooks: {
      [boundary]: () => {
        throw new Error(`injected ${boundary}`);
      },
    },
  });
  expect(failed.ok).toBe(false);
  if (failed.ok) return;
  await expect(
    recoverFreshBootstrap({
      ...input,
      publishedByCallId: "recover-call",
      expectedJournalDigest: failed.receipt.digest,
    }),
  ).resolves.toMatchObject({ ok: true });
});

it("rejects V1 proposal and journal shapes even when rehashed", async () => {
  const input = await fixture("absent");
  const oldProposal = structuredClone(input.proposal) as Record<
    string,
    unknown
  >;
  oldProposal.version = 1;
  delete oldProposal.digest;
  oldProposal.digest = stableDigest(oldProposal);
  expect(() => assertExactFreshBootstrapProposal(oldProposal as never)).toThrow(
    "canonical V3",
  );
  const result = await publishFreshBootstrap({
    ...input,
    publishedByCallId: "publish-call",
    hooks: {
      afterStageCreation: () => {
        throw new Error("fixture failure");
      },
    },
  });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  const oldJournal = structuredClone(result.receipt) as Record<string, unknown>;
  oldJournal.version = 1;
  delete oldJournal.digest;
  oldJournal.digest = stableDigest(oldJournal);
  expect(() =>
    assertCanonicalFreshBootstrapJournal(oldJournal as never),
  ).toThrow(/canonical V3|malformed/u);
  const mixed = {
    ...result.receipt,
    status: "pending",
    unknownTerminalAuthority: true,
  } as Record<string, unknown>;
  delete mixed.digest;
  mixed.digest = stableDigest(mixed);
  expect(() => assertCanonicalFreshBootstrapJournal(mixed as never)).toThrow(
    "malformed",
  );
});

it("serializes distinct proposals for the same exact-empty destination", async () => {
  const input = await fixture("empty-directory");
  const secondProposal = await deriveFreshBootstrapProposal({
    capability: input.capability,
    destinationPath: input.destinationPath,
    expectedPrestate: "empty-directory",
    repositoryIdentity: {
      ...input.proposal.repositoryIdentity,
      commitMessage: "A distinct approved bootstrap",
    },
    sourceReceipt: input.sourceReceipt,
    review: input.review,
    protectedPaths: [],
    readOverlayFile: input.readOverlayFile,
  });
  expect(secondProposal.lockPath).toBe(input.proposal.lockPath);
  const results = await Promise.allSettled([
    publishFreshBootstrap({ ...input, publishedByCallId: "first-call" }),
    publishFreshBootstrap({
      ...input,
      proposal: secondProposal,
      publishedByCallId: "second-call",
    }),
  ]);
  const succeeded = results.filter(
    (result) => result.status === "fulfilled" && result.value.ok,
  );
  expect(succeeded).toHaveLength(1);
  const winningCommit =
    succeeded[0].status === "fulfilled" && succeeded[0].value.ok
      ? succeeded[0].value.receipt.headCommit
      : undefined;
  expect([
    input.proposal.expectedInitialCommit,
    secondProposal.expectedInitialCommit,
  ]).toContain(winningCommit);
});

it("refuses recovery when a rehashed durable layout identity no longer matches", async () => {
  const input = await fixture("absent");
  const failed = await publishFreshBootstrap({
    ...input,
    publishedByCallId: "publish-call",
    hooks: {
      afterStageCreation: () => {
        throw new Error("fixture failure");
      },
    },
  });
  expect(failed.ok).toBe(false);
  if (failed.ok) return;
  const receipt = failed.receipt;
  if (receipt.layout.phase !== "stage-owned") return;
  const tampered = structuredClone(receipt);
  if (tampered.layout.phase !== "stage-owned") return;
  tampered.layout.stageIdentity.inode = "0";
  const unsigned = { ...tampered } as Record<string, unknown>;
  delete unsigned.digest;
  tampered.digest = stableDigest(unsigned);
  await writeFile(input.proposal.journalPath, `${JSON.stringify(tampered)}\n`);
  await expect(
    recoverFreshBootstrap({
      ...input,
      publishedByCallId: "recover-call",
      expectedJournalDigest: tampered.digest,
    }),
  ).rejects.toThrow("durable layout receipt");
});

it("rejects rehashed success receipts with malformed closed identities", async () => {
  const input = await fixture("absent");
  const result = await publishFreshBootstrap({
    ...input,
    publishedByCallId: "publish-call",
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const tampered = structuredClone(result.receipt) as Record<string, unknown>;
  tampered.destinationIdentity = {
    ...(tampered.destinationIdentity as object),
    inode: "not-an-inode",
  };
  delete tampered.digest;
  tampered.digest = stableDigest(tampered);
  expect(() => assertCanonicalFreshBootstrapJournal(tampered as never)).toThrow(
    "identity is malformed",
  );
});
