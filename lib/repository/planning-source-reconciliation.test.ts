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
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { appBaselineReceiptSchema } from "./app-baseline";
import { planningSourceReconciliationProgram } from "./planning-source-reconciliation";

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
  const run = (program = planningSourceReconciliationProgram, requestedTargetSha = targetSha) =>
    spawnSync(
      process.execPath,
      [
        "-e",
        program,
        JSON.stringify({
          appId: baseline.appId,
          baseline,
          baselineMarkerPath,
          branchRef: "refs/heads/main",
          fetchRemote: false,
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
        "  complete(plan);\n  console.log",
        "  process.exit(75);\n  console.log",
      );
      expect(f.run(interrupted).status).toBe(75);
      expect(f.git("rev-parse", "HEAD")).toBe(f.oldHead);
      expect(f.run().status).toBe(0);
      expect(f.git("rev-parse", "HEAD")).toBe(f.targetSha);
      expect(readFileSync(path.join(f.root, "platform.txt"), "utf-8")).toBe(
        "authored before interruption\n",
      );
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
