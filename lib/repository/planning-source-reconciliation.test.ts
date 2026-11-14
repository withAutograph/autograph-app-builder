import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { appBaselineReceiptSchema } from "./app-baseline";
import { GENERATED_RELEASE_MEMBERS } from "../provisioning/hosted-operator-sandbox-launcher";
import {
  PlanningReleaseConflictError,
  planningSourceReconciliationProgram,
  reconcilePlanningSource,
} from "./planning-source-reconciliation";
import type { PublishedPlanningRelease } from "./planning-source-reconciliation";

const fixture = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "source-reconciliation-"));
  const stateRoot = mkdtempSync(path.join(os.tmpdir(), "source-reconciliation-state-"));
  const baselineMarkerPath = path.join(stateRoot, "baseline.json");
  const git = (...args: string[]) =>
    execFileSync(
      "/usr/bin/git",
      [
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "commit.gpgsign=false",
        "-C",
        root,
        ...args,
      ],
      {
        encoding: "utf-8",
      },
    ).trim();
  const write = (file: string, content: string) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), content);
  };
  git("init", "--quiet");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.test");
  write(".gitignore", ".app-builder/\n.env.local\n");
  write("platform.txt", "original platform\n");
  write(".config/mise/config.toml", '[tasks."app:local"]\nrun = "old local"\n');
  write("delete.txt", "delete locally\n");
  write("conflict.txt", "base\n");
  write("apps/spend-review/product.txt", "historical product\n");
  write("apps/spend-review/schema/release/v1/release.json", "immutable v1\n");
  write("apps/spend-review/.config/mise/tasks/test", "old tooling\n");
  git("add", ".");
  git("commit", "--quiet", "-m", "old source");
  const oldHead = git("rev-parse", "HEAD");
  const oldTree = git("rev-parse", "HEAD^{tree}");
  write(".config/mise/scripts/repository/app-describe.ts", "descriptor\n");
  write(".config/mise/config.toml", '[tasks."app:describe"]\nrun = "descriptor"\n');
  write("apps/spend-review/product.txt", "later upstream product\n");
  write("apps/spend-review/later.txt", "future product\n");
  write("apps/spend-review/schema/release/v2/release.json", "immutable v2\n");
  write("apps/spend-review/.config/mise/tasks/test", "new tooling\n");
  write("new-platform.txt", "new platform\n");
  write("conflict.txt", "upstream edit\n");
  git("add", ".");
  git("commit", "--quiet", "-m", "current platform");
  const targetSha = git("rev-parse", "HEAD");
  git("checkout", "--quiet", "--detach", oldHead);
  const baseline = {
    appId: "spend-review",
    historical: {
      commitSha: oldHead,
      name: "arrusted",
      owner: "example",
      repositoryId: "1",
      treeSha: oldTree,
    },
    selectedByCallId: "select",
    sessionId: "session",
    source: { commitSha: oldHead, kind: "commit" },
  };
  const unsigned = {
    ...baseline,
    platform: { commitSha: oldHead, ref: "refs/heads/main", treeSha: oldTree },
    platformSourceDigest: "a".repeat(64),
    projectedByCallId: "project",
    removedFiles: 0,
    restoredFiles: 1,
    retainedReleaseFiles: 1,
    sourceDigest: "b".repeat(64),
    unexposedReleaseDigest: "c".repeat(64),
    version: 1,
  };
  writeFileSync(
    baselineMarkerPath,
    JSON.stringify({
      platformFiles: [],
      receipt: {
        ...unsigned,
        digest: createHash("sha256").update(JSON.stringify(unsigned)).digest("hex"),
      },
      unexposedReleasePrefixes: [],
    }),
  );
  const run = (
    program = planningSourceReconciliationProgram,
    requestedTargetSha = targetSha,
    publishedRelease?: PublishedPlanningRelease,
    adoptPublishedSchemaCue?: true,
    preserveSourceHead?: true,
  ) =>
    spawnSync(
      process.execPath,
      [
        "-e",
        program,
        JSON.stringify({
          adoptPublishedSchemaCue,
          appId: baseline.appId,
          baseline,
          baselineMarkerPath,
          branchRef: "refs/heads/main",
          fetchRemote: false,
          preserveSourceHead,
          publishedRelease,
          root,
          sessionId: "session",
          stateRoot,
          targetSha: requestedTargetSha,
        }),
      ],
      { cwd: root, encoding: "utf-8" },
    );
  return { baseline, baselineMarkerPath, git, oldHead, root, run, stateRoot, targetSha, write };
};

const releasedCuePath = "apps/spend-review/schema/spend-review.cue";
const releasedCue = 'label: "Creator actor ID"\n';
const releaseDirectory = "apps/spend-review/schema/release/v3";
const artifactFile = `${releaseDirectory}/app-artifact.json`;
const scratchFile = `${releaseDirectory}/unpublished-draft.txt`;
const publishedFixture = (laterMember?: string) => {
  const f = fixture();
  f.git("checkout", "--quiet", "--detach", f.targetSha);
  const files = Object.fromEntries(
    GENERATED_RELEASE_MEMBERS.map((member) => {
      const content = `Merged ${member}\n`;
      f.write(`${releaseDirectory}/${member}`, content);
      return [member, createHash("sha256").update(content).digest("hex")];
    }),
  );
  f.write(releasedCuePath, releasedCue);
  f.git("add", releaseDirectory, releasedCuePath);
  f.git("commit", "--quiet", "-m", "Merge owned release");
  const mergeSha = f.git("rev-parse", "HEAD");
  if (laterMember !== undefined) {
    const file = `${releaseDirectory}/${laterMember}`;
    f.write(file, "Unreviewed later bytes\n");
    f.git("add", file);
  }
  f.write("successor-platform.txt", "Platform updated after the merge\n");
  f.git("add", "successor-platform.txt");
  f.git("commit", "--quiet", "-m", "Later platform source");
  const currentSource = f.git("rev-parse", "HEAD");
  f.git("checkout", "--quiet", "--detach", f.oldHead);
  f.write(artifactFile, "Original unpublished artifact\n");
  f.write(scratchFile, "Original unpublished release-only work\n");
  f.write("apps/spend-review/product.txt", "Current app work\n");
  const cueSha256 = createHash("sha256").update(releasedCue).digest("hex");
  return { ...f, currentSource, proof: { cueSha256, files, mergeSha, releaseId: "v3" } };
};

describe("owned planning source reconciliation", () => {
  it("carries edits, deletions, new files and historical product forward with current tooling", () => {
    const f = fixture();
    try {
      f.write("platform.txt", "authored platform\n");
      f.write("new-file.txt", "untracked authored bytes\n");
      symlinkSync("not-present-target", path.join(f.root, "authored-link"));
      f.write("apps/spend-review/product.txt", "historical product with authored edit\n");
      rmSync(path.join(f.root, "delete.txt"));
      const result = f.run();
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(f.git("rev-parse", "HEAD")).toBe(f.targetSha);
      expect(readFileSync(path.join(f.root, "platform.txt"), "utf-8")).toBe("authored platform\n");
      expect(readFileSync(path.join(f.root, "new-file.txt"), "utf-8")).toBe(
        "untracked authored bytes\n",
      );
      expect(() => readFileSync(path.join(f.root, "delete.txt"))).toThrow();
      expect(readFileSync(path.join(f.root, "apps/spend-review/product.txt"), "utf-8")).toBe(
        "historical product with authored edit\n",
      );
      expect(() => readFileSync(path.join(f.root, "apps/spend-review/later.txt"))).toThrow();
      expect(
        readFileSync(path.join(f.root, "apps/spend-review/.config/mise/tasks/test"), "utf-8"),
      ).toBe("new tooling\n");
      expect(
        readFileSync(
          path.join(f.root, "apps/spend-review/schema/release/v1/release.json"),
          "utf-8",
        ),
      ).toBe("immutable v1\n");
      expect(
        readFileSync(
          path.join(f.root, "apps/spend-review/schema/release/v2/release.json"),
          "utf-8",
        ),
      ).toBe("immutable v2\n");
      expect(f.git("status", "--porcelain")).toContain("?? new-file.txt");
      expect(readlinkSync(path.join(f.root, "authored-link"))).toBe("not-present-target");
      const marker = z
        .object({
          receipt: appBaselineReceiptSchema,
          unexposedReleasePrefixes: z.array(z.string()),
        })
        .parse(JSON.parse(readFileSync(f.baselineMarkerPath, "utf-8")));
      expect(marker.receipt.platform.commitSha).toBe(f.targetSha);
      expect(marker.receipt.sourceDigest).toBe("b".repeat(64));
      expect(marker.unexposedReleasePrefixes).toContain("apps/spend-review/schema/release/v2/");
      const { checkpointRef: checkpoint } = z
        .object({ checkpointRef: z.string() })
        .parse(JSON.parse(result.stdout));
      expect(f.git("show", `${checkpoint}:platform.txt`)).toBe("authored platform");
      expect(f.git("show", `${checkpoint}:.config/mise/config.toml`)).toContain(
        '[tasks."app:local"]',
      );
    } finally {
      rmSync(f.root, { force: true, recursive: true });
      rmSync(f.stateRoot, { force: true, recursive: true });
    }
  });
  it("reports actual merge conflicts and retains both current source and checkpoint bytes", () => {
    const f = fixture();
    try {
      f.write("conflict.txt", "authored conflict\n");
      const result = f.run();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("conflicts with authored changes");
      expect(f.git("rev-parse", "HEAD")).toBe(f.oldHead);
      expect(readFileSync(path.join(f.root, "conflict.txt"), "utf-8")).toBe("authored conflict\n");
      const ref = `refs/app-builder/source-checkpoints/${createHash("sha256").update("session").digest("hex")}`;
      expect(f.git("show", `${ref}:conflict.txt`)).toBe("authored conflict");
    } finally {
      rmSync(f.root, { force: true, recursive: true });
      rmSync(f.stateRoot, { force: true, recursive: true });
    }
  });
  it("adopts one exact merged immutable cut and checkpoints the old release and authored work", () => {
    const f = publishedFixture();
    try {
      const collision = f.run(planningSourceReconciliationProgram, f.currentSource);
      expect(collision.status).not.toBe(0);
      expect(collision.stderr).toContain("APP_BUILDER_RELEASE_CONFLICT v3");
      expect(f.git("rev-parse", "HEAD")).toBe(f.oldHead);

      const result = f.run(planningSourceReconciliationProgram, f.currentSource, f.proof);
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(f.git("rev-parse", "HEAD")).toBe(f.currentSource);
      expect(readFileSync(path.join(f.root, artifactFile), "utf-8")).toBe(
        "Merged app-artifact.json\n",
      );
      expect(() => readFileSync(path.join(f.root, scratchFile), "utf-8")).toThrow();
      expect(readFileSync(path.join(f.root, "apps/spend-review/product.txt"), "utf-8")).toBe(
        "Current app work\n",
      );
      const { checkpointRef } = z
        .object({ checkpointRef: z.string() })
        .parse(JSON.parse(result.stdout));
      expect(f.git("show", `${checkpointRef}:${artifactFile}`)).toBe(
        "Original unpublished artifact",
      );
      expect(f.git("show", `${checkpointRef}:${scratchFile}`)).toBe(
        "Original unpublished release-only work",
      );
      const marker = z
        .object({ unexposedReleasePrefixes: z.array(z.string()) })
        .parse(JSON.parse(readFileSync(f.baselineMarkerPath, "utf-8")));
      expect(marker.unexposedReleasePrefixes).not.toContain(`${releaseDirectory}/`);
    } finally {
      rmSync(f.root, { force: true, recursive: true });
      rmSync(f.stateRoot, { force: true, recursive: true });
    }
  });

  it("repairs a verified published release when HEAD already matches current source", () => {
    const f = publishedFixture();
    try {
      f.git("checkout", "--quiet", "--force", "--detach", f.currentSource);
      const sql = `${releaseDirectory}/sql-bundle.sql`;
      const product = "apps/spend-review/product.txt";
      const displaced = "Regenerated predecessor SQL\n";
      const authored = "Unrelated authored work  \n\n";
      f.write(sql, displaced);
      const extra = "Unpublished output inside the same release\n";
      f.write(scratchFile, extra);
      f.write(product, authored);

      const result = f.run(planningSourceReconciliationProgram, f.currentSource, f.proof);
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      const { changed, checkpointRef } = z
        .object({ changed: z.boolean(), checkpointRef: z.string() })
        .parse(JSON.parse(result.stdout));
      expect(changed).toBe(true);
      expect(f.git("rev-parse", "HEAD")).toBe(f.currentSource);
      expect(readFileSync(path.join(f.root, sql), "utf-8")).toBe("Merged sql-bundle.sql\n");
      expect(() => readFileSync(path.join(f.root, scratchFile))).toThrow();
      expect(readFileSync(path.join(f.root, product), "utf-8")).toBe(authored);
      for (const [file, original] of [
        [sql, displaced],
        [scratchFile, extra],
        [product, authored],
      ]) {
        expect(
          execFileSync("/usr/bin/git", ["-C", f.root, "show", `${checkpointRef}:${file}`], {
            encoding: "utf-8",
          }),
        ).toBe(original);
      }
    } finally {
      rmSync(f.root, { force: true, recursive: true });
      rmSync(f.stateRoot, { force: true, recursive: true });
    }
  });

  it("restores only the published CUE and verifies the displaced private input remains checkpointed", () => {
    const f = publishedFixture();
    try {
      f.git("checkout", "--quiet", "--force", "--detach", f.currentSource);
      const product = "apps/spend-review/product.txt";
      const stale = 'label: "Creator Actor ID"\n';
      const authored = "Unrelated authored product bytes  \n";
      f.write(releasedCuePath, stale);
      f.write(product, authored);
      const ordinary = f.run(planningSourceReconciliationProgram, f.currentSource, f.proof);
      expect(ordinary.status).toBe(0);
      expect(readFileSync(path.join(f.root, releasedCuePath), "utf-8")).toBe(stale);

      const result = f.run(planningSourceReconciliationProgram, f.currentSource, f.proof, true);
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(f.git("rev-parse", "HEAD")).toBe(f.currentSource);
      expect(readFileSync(path.join(f.root, releasedCuePath), "utf-8")).toBe(releasedCue);
      expect(readFileSync(path.join(f.root, product), "utf-8")).toBe(authored);
      const { checkpointRef } = z
        .object({ checkpointRef: z.string() })
        .parse(JSON.parse(result.stdout));
      expect(f.git("show", `${checkpointRef}:${releasedCuePath}`)).toBe(stale.trimEnd());

      const retry = f.run(planningSourceReconciliationProgram, f.currentSource, f.proof, true);
      expect(retry.status).toBe(0);
      expect(f.git("show", `${checkpointRef}:${releasedCuePath}`)).toBe(stale.trimEnd());
    } finally {
      rmSync(f.root, { force: true, recursive: true });
      rmSync(f.stateRoot, { force: true, recursive: true });
    }
  });

  it("projects the published schema without rebasing the approved worktree or index", () => {
    const f = publishedFixture();
    try {
      const product = "apps/spend-review/product.txt";
      f.write(product, "Staged authored bytes\n");
      f.git("add", "--", product);
      f.write(product, "Separate unstaged authored bytes\n");
      f.write(releasedCuePath, "Outdated draft CUE\n");
      const approvedIndex = f.git("write-tree");
      const markerBefore = readFileSync(f.baselineMarkerPath);

      const result = f.run(
        planningSourceReconciliationProgram,
        f.currentSource,
        f.proof,
        true,
        true,
      );
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      const { checkpointRef, sourceSha, sourceTree } = z
        .object({ checkpointRef: z.string(), sourceSha: z.string(), sourceTree: z.string() })
        .parse(JSON.parse(result.stdout));
      expect(sourceSha).toBe(f.oldHead);
      expect(sourceTree).toBe(f.git("rev-parse", `${f.oldHead}^{tree}`));
      expect(f.git("rev-parse", "HEAD")).toBe(f.oldHead);
      expect(f.git("write-tree")).toBe(approvedIndex);
      expect(readFileSync(f.baselineMarkerPath)).toEqual(markerBefore);
      expect(readFileSync(path.join(f.root, product), "utf-8")).toBe(
        "Separate unstaged authored bytes\n",
      );
      expect(readFileSync(path.join(f.root, releasedCuePath), "utf-8")).toBe(releasedCue);
      expect(readFileSync(path.join(f.root, artifactFile), "utf-8")).toBe(
        "Merged app-artifact.json\n",
      );
      expect(() => readFileSync(path.join(f.root, "successor-platform.txt"))).toThrow();
      expect(() => readFileSync(path.join(f.root, scratchFile))).toThrow();
      expect(f.git("show", `${checkpointRef}:${releasedCuePath}`)).toBe("Outdated draft CUE");
      expect(f.git("show", `${checkpointRef}:${artifactFile}`)).toBe(
        "Original unpublished artifact",
      );
    } finally {
      rmSync(f.root, { force: true, recursive: true });
      rmSync(f.stateRoot, { force: true, recursive: true });
    }
  });

  it("resumes an interrupted CUE adoption only with the same published proof", () => {
    const f = publishedFixture();
    try {
      f.git("checkout", "--quiet", "--force", "--detach", f.currentSource);
      const local = 'label: "Private draft"\n';
      f.write(releasedCuePath, local);
      const interrupted = planningSourceReconciliationProgram.replace(
        "    writeFileSync(destination, bytes);",
        `    if (file === ${JSON.stringify(releasedCuePath)}) throw Error("fixture interruption");\n    writeFileSync(destination, bytes);`,
      );
      const failure = f.run(interrupted, f.currentSource, f.proof, true, true);
      expect(failure.stderr).toContain("fixture interruption");

      const ordinary = f.run(planningSourceReconciliationProgram, f.currentSource, f.proof);
      expect(ordinary.stderr).toContain("Resume the pending source reconciliation");
      const differentTarget = f.run(
        planningSourceReconciliationProgram,
        f.targetSha,
        f.proof,
        true,
      );
      expect(differentTarget.stderr).toContain("Resume the pending source reconciliation");
      expect(readFileSync(path.join(f.root, releasedCuePath), "utf-8")).toBe(local);

      const retry = f.run(
        planningSourceReconciliationProgram,
        f.currentSource,
        f.proof,
        true,
        true,
      );
      expect(retry.status).toBe(0);
      expect(readFileSync(path.join(f.root, releasedCuePath), "utf-8")).toBe(releasedCue);
    } finally {
      rmSync(f.root, { force: true, recursive: true });
      rmSync(f.stateRoot, { force: true, recursive: true });
    }
  });

  it.each(["changed target", "absent target", "wrong digest"] as const)(
    "preserves private files if the released CUE proof fails (%s)",
    (failure) => {
      const f = publishedFixture();
      try {
        f.git("checkout", "--quiet", "--force", "--detach", f.currentSource);
        let { proof } = f;
        if (failure === "wrong digest") {
          proof = { ...proof, cueSha256: "f".repeat(64) };
        } else {
          if (failure === "absent target") {
            rmSync(path.join(f.root, releasedCuePath));
          } else {
            f.write(releasedCuePath, 'label: "A newer schema"\n');
          }
          f.git("add", "--all", "--", releasedCuePath);
          f.git("commit", "--quiet", "-m", "Advance tracked app schema");
        }
        const head = f.git("rev-parse", "HEAD");
        const local = 'label: "Private draft"\n';
        f.write(releasedCuePath, local);
        const result = f.run(planningSourceReconciliationProgram, head, proof, true);
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("The published schema CUE does not match");
        expect(f.git("rev-parse", "HEAD")).toBe(head);
        expect(readFileSync(path.join(f.root, releasedCuePath), "utf-8")).toBe(local);
      } finally {
        rmSync(f.root, { force: true, recursive: true });
        rmSync(f.stateRoot, { force: true, recursive: true });
      }
    },
  );

  it.each([
    { failure: "hash" },
    { failure: "unmerged" },
    { failure: "changed target", laterMember: "app-artifact.json" },
    { failure: "extra target member", laterMember: "extra.bin" },
    { failure: "tracked prior" },
  ])(
    "preserves the checkout when the exact published cut proof fails ($failure)",
    ({ failure, laterMember }) => {
      const f = publishedFixture(laterMember);
      try {
        const target = failure === "unmerged" ? f.targetSha : f.currentSource;
        let { proof } = f;
        let expectedHead = f.oldHead;
        let original = "Original unpublished artifact\n";
        if (failure === "hash") {
          proof = { ...proof, files: { ...proof.files, "app-artifact.json": "f".repeat(64) } };
        }
        if (failure === "tracked prior") {
          original = "Different existing release bytes\n";
          f.write(artifactFile, original);
          f.git("add", artifactFile);
          f.git("commit", "--quiet", "-m", "Existing tracked release bytes");
          expectedHead = f.git("rev-parse", "HEAD");
        }
        const result = f.run(planningSourceReconciliationProgram, target, proof);
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("selected merged release does not match");
        expect(f.git("rev-parse", "HEAD")).toBe(expectedHead);
        expect(readFileSync(path.join(f.root, artifactFile), "utf-8")).toBe(original);
      } finally {
        rmSync(f.root, { force: true, recursive: true });
        rmSync(f.stateRoot, { force: true, recursive: true });
      }
    },
  );

  it("reports a typed generated release conflict without returning local filenames", async () => {
    const sandbox = {
      run: vi
        .fn<Parameters<typeof reconcilePlanningSource>[0]["sandbox"]["run"]>()
        .mockResolvedValue({
          exitCode: 1,
          stdout: "",
          stderr: "APP_BUILDER_RELEASE_CONFLICT 2026-11-16.v8\nprivate/filename\n",
        }),
    } satisfies Parameters<typeof reconcilePlanningSource>[0]["sandbox"];
    await expect(
      reconcilePlanningSource({
        appId: "spend-review",
        branchRef: "refs/heads/main",
        repository: "https://github.com/example/arrusted.git",
        sandbox,
        sessionId: "session",
        targetSha: "a".repeat(40),
        token: "fixture",
      }),
    ).rejects.toMatchObject({
      name: PlanningReleaseConflictError.name,
      releaseId: "2026-11-16.v8",
      message:
        "A saved app release conflicts with the current repository source. Its original bytes are preserved.",
    });
  });

  it("keeps an unchanged current checkout intact on retry", () => {
    const f = fixture();
    try {
      expect(f.run().status).toBe(0);
      f.write("platform.txt", "newer authored bytes\n");
      const result = f.run();
      expect(result.status).toBe(0);
      expect(z.object({ changed: z.boolean() }).parse(JSON.parse(result.stdout)).changed).toBe(
        false,
      );
      expect(readFileSync(path.join(f.root, "platform.txt"), "utf-8")).toBe(
        "newer authored bytes\n",
      );
    } finally {
      rmSync(f.root, { force: true, recursive: true });
      rmSync(f.stateRoot, { force: true, recursive: true });
    }
  });
  it("replays a checkpointed interrupted transition without losing authored source", () => {
    const f = fixture();
    try {
      f.write("platform.txt", "authored before interruption\n");
      const interrupted = planningSourceReconciliationProgram.replace(
        "    writeFileSync(destination, bytes);",
        '    if (file === "new-platform.txt") throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });\n    writeFileSync(destination, bytes);',
      );
      const failure = f.run(interrupted);
      expect(failure.status).not.toBe(0);
      expect(failure.stderr).toContain("ENOSPC");
      expect(f.git("rev-parse", "HEAD")).toBe(f.oldHead);
      const ref = `refs/app-builder/source-checkpoints/${createHash("sha256").update("session").digest("hex")}`;
      expect(f.git("show", `${ref}:platform.txt`)).toBe("authored before interruption");

      // Simulate the disk pressure a replay would hit if it rewrote already-correct
      // files, including ones written before the interruption.
      const replay = planningSourceReconciliationProgram.replace(
        "    writeFileSync(destination, bytes);",
        '    if (file !== "new-platform.txt") throw Object.assign(new Error("unexpected file rewrite: " + file), { code: "ENOSPC" });\n    writeFileSync(destination, bytes);',
      );
      const result = f.run(replay);
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(f.git("rev-parse", "HEAD")).toBe(f.targetSha);
      expect(readFileSync(path.join(f.root, "platform.txt"), "utf-8")).toBe(
        "authored before interruption\n",
      );
      expect(readFileSync(path.join(f.root, "new-platform.txt"), "utf-8")).toBe("new platform\n");
      expect(f.git("show", `${ref}:platform.txt`)).toBe("authored before interruption");
    } finally {
      rmSync(f.root, { force: true, recursive: true });
      rmSync(f.stateRoot, { force: true, recursive: true });
    }
  });
  it("rejects an actual ignored private-file collision before replacing source", () => {
    const f = fixture();
    try {
      f.git("checkout", "--quiet", "--detach", f.targetSha);
      f.write(".env.local", "upstream tracked environment\n");
      f.git("add", "--force", ".env.local");
      f.git("commit", "--quiet", "-m", "colliding tracked source");
      const collidingTarget = f.git("rev-parse", "HEAD");
      f.git("checkout", "--quiet", "--detach", f.oldHead);
      f.write(".env.local", "private local credential bytes\n");
      const result = f.run(planningSourceReconciliationProgram, collidingTarget);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("overwrite ignored local files");
      expect(f.git("rev-parse", "HEAD")).toBe(f.oldHead);
      expect(readFileSync(path.join(f.root, ".env.local"), "utf-8")).toBe(
        "private local credential bytes\n",
      );
    } finally {
      rmSync(f.root, { force: true, recursive: true });
      rmSync(f.stateRoot, { force: true, recursive: true });
    }
  });
  it("never executes repository-local checkout filters or exposes the source token to them", () => {
    const f = fixture();
    try {
      f.git("checkout", "--quiet", "--detach", f.targetSha);
      f.write(".gitattributes", "* filter=hostile\n");
      f.git("add", ".gitattributes");
      f.git("commit", "--quiet", "-m", "filter declaration");
      const target = f.git("rev-parse", "HEAD");
      f.git("checkout", "--quiet", "--detach", f.oldHead);
      const flag = path.join(f.stateRoot, "filter-executed");
      f.git("config", "filter.hostile.smudge", `touch "${flag}"`);
      const result = f.run(planningSourceReconciliationProgram, target);
      expect(result.status).toBe(0);
      expect(() => readFileSync(flag)).toThrow();
      expect(planningSourceReconciliationProgram).not.toContain('"read-tree", "--reset", "-u"');
    } finally {
      rmSync(f.root, { force: true, recursive: true });
      rmSync(f.stateRoot, { force: true, recursive: true });
    }
  });
});
