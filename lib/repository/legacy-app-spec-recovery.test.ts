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
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import type { SandboxSession } from "eve/sandbox";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppBaselineReceipt, AppBaselineSelection } from "./app-baseline";
import { recoverLegacyAppSpecTransport } from "./legacy-app-spec-recovery";
import { compactAcceptedPlanningInput } from "./compact-accepted-planning-input";
import { planningOverlayRoot } from "./dependency-cache";
import { streamVerifiedPrototypeArtifact } from "../agent/prototype-artifact-stream";
import type { PrototypeArtifactV2 } from "../agent/workflow-state";
import type { TargetApplyReceipt } from "./target-apply";

const roots: string[] = [];
const hash = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");
const digest = hash("fixture");
const accepted = "# Exact accepted product brief\n";
const specPath = ".config/app-specs/demo.md";
const git = (root: string, ...args: string[]): string =>
  execFileSync("/usr/bin/git", args, { cwd: root, encoding: "utf-8" }).trim();

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

const fixture = (original?: string) => {
  const root = mkdtempSync(nodePath.join(tmpdir(), "builder-legacy-spec-"));
  roots.push(root);
  const checkout = nodePath.join(root, "repository");
  mkdirSync(nodePath.join(checkout, ".config/app-specs"), { recursive: true });
  mkdirSync(nodePath.join(checkout, "apps/demo"), { recursive: true });
  writeFileSync(nodePath.join(checkout, "apps/demo/main.ts"), "authored app\n");
  writeFileSync(nodePath.join(checkout, ".config/app-specs/demo.cue"), "canonical cue\n");
  if (original !== undefined) {
    writeFileSync(nodePath.join(checkout, specPath), original);
    chmodSync(nodePath.join(checkout, specPath), 0o755);
  }
  git(checkout, "init", "--initial-branch=main");
  git(
    checkout,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "-c",
    "commit.gpgsign=false",
    "add",
    ".",
  );
  git(
    checkout,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "source",
  );
  const sha = git(checkout, "rev-parse", "HEAD");
  const tree = git(checkout, "rev-parse", "HEAD^{tree}");
  const repository = { name: "source", owner: "example", repositoryId: "100" };
  const selection: AppBaselineSelection = {
    appId: "demo",
    historical: {
      commitSha: sha,
      name: repository.name,
      owner: repository.owner,
      repositoryId: repository.repositoryId,
      treeSha: tree,
    },
    selectedByCallId: "select",
    sessionId: "session",
    source: { commitSha: sha, kind: "commit" },
  };
  const platformFiles =
    original === undefined ? [] : [{ digest: hash(original), mode: "755", path: specPath }];
  const unsignedBaseline = {
    ...selection,
    platform: { commitSha: sha, ref: "refs/heads/main", treeSha: tree },
    platformSourceDigest: hash(JSON.stringify(platformFiles)),
    projectedByCallId: "project",
    removedFiles: 0,
    restoredFiles: 0,
    retainedReleaseFiles: 0,
    sourceDigest: digest,
    unexposedReleaseDigest: hash(JSON.stringify([])),
    version: 1 as const,
  };
  const receipt: AppBaselineReceipt = {
    ...unsignedBaseline,
    digest: hash(JSON.stringify(unsignedBaseline)),
  };
  const markerPath = nodePath.join(root, ".app-builder/app-baselines/demo.json");
  mkdirSync(nodePath.dirname(markerPath), { recursive: true });
  writeFileSync(
    markerPath,
    JSON.stringify({ platformFiles, receipt, unexposedReleasePrefixes: [] }),
  );
  const unsignedApply: Omit<TargetApplyReceipt, "digest"> = {
    appSpecDigest: hash(accepted),
    appSpecPath: specPath,
    appliedByCallId: "apply",
    applyRoot: checkout,
    artifactRevision: digest,
    changedContentDigest: digest,
    changes: [],
    command: {
      exitCode: 0,
      name: "iterate-existing-app",
      stderrDigest: digest,
      stdoutDigest: digest,
    },
    dependencyCacheContentDigest: digest,
    dependencyCacheDigest: digest,
    dependencyReceiptDigest: digest,
    eligibilityDigest: digest,
    identityDigest: digest,
    imageDigest: digest,
    planningTreeDigest: digest,
    postTree: [{ digest: hash(accepted), mode: "644", path: specPath }],
    postTreeDigest: digest,
    preTree: [],
    preTreeDigest: digest,
    preparedTreeDigest: digest,
    proposalDigest: digest,
    sourceReceiptDigest: digest,
    sourceSha: sha,
    sourceTree: tree,
    status: "applied",
    targetReceipt: {
      appId: "demo",
      mutations: ["apps/demo", "microfrontends.json"],
      omittedAuthorities: ["provider-provisioning", "deployment", "production-readiness"],
      recovered: false,
      topology: { newDigest: digest, oldDigest: digest, path: "microfrontends.json" },
      version: 1,
      workspacePath: "apps/demo",
    },
    version: 2,
    workspaceDigest: digest,
  };
  const apply: TargetApplyReceipt = {
    ...unsignedApply,
    digest: hash(JSON.stringify(unsignedApply)),
  };
  writeFileSync(nodePath.join(checkout, specPath), accepted);
  chmodSync(nodePath.join(checkout, specPath), 0o644);
  const sandbox: SandboxSession = {
    async readBinaryFile({ path }) {
      const file = nodePath.join(root, path);
      return existsSync(file) ? await readFile(file) : null;
    },
    readFile: vi.fn(),
    async readTextFile({ path }) {
      return await readFile(nodePath.join(root, path), "utf-8");
    },
    async removePath({ path, force, recursive }) {
      await rm(nodePath.join(root, path), { force, recursive });
    },
    resolvePath: (path) => nodePath.resolve(root, path),
    async run({ command }) {
      await Promise.resolve();
      const result = spawnSync("/bin/sh", ["-c", command], {
        cwd: root,
        encoding: "utf-8",
        env: {
          ...process.env,
          PATH: `${nodePath.dirname(process.execPath)}:${process.env.PATH ?? ""}`,
        },
      });
      return { exitCode: result.status ?? 1, stderr: result.stderr, stdout: result.stdout };
    },
    spawn: vi.fn(),
    async writeBinaryFile({ path, content }) {
      await writeFile(nodePath.join(root, path), content);
    },
    writeFile: vi.fn(),
    async writeTextFile({ path, content }) {
      const file = nodePath.join(root, path);
      await mkdir(nodePath.dirname(file), { recursive: true });
      await writeFile(file, content);
    },
  };
  const input = {
    appId: "demo",
    appSpecDigest: hash(accepted),
    apply,
    artifactRevision: digest,
    baseline: { receipt, selection },
    readAcceptedContent: async () => await Promise.resolve(accepted),
    repository,
    sandbox,
    sessionId: "session",
    workspaceRoot: root,
  };
  return { checkout, input, markerPath, root };
};

describe("legacy accepted AppSpec transport recovery", () => {
  it("removes only the proven Builder-created transport even when the latest apply has no markdown change", async () => {
    const f = fixture();
    const candidate = nodePath.join(f.root, ".app-builder/draft-reconcile/retained");
    mkdirSync(candidate, { recursive: true });
    writeFileSync(nodePath.join(candidate, "repair"), "old candidate");
    await expect(recoverLegacyAppSpecTransport(f.input)).resolves.toEqual({ status: "restored" });
    expect(existsSync(nodePath.join(f.checkout, specPath))).toBe(false);
    expect(readFileSync(nodePath.join(f.checkout, "apps/demo/main.ts"), "utf-8")).toBe(
      "authored app\n",
    );
    expect(readFileSync(nodePath.join(f.checkout, ".config/app-specs/demo.cue"), "utf-8")).toBe(
      "canonical cue\n",
    );
    expect(readFileSync(nodePath.join(candidate, "repair"), "utf-8")).toBe("old candidate");
    expect(
      readFileSync(
        nodePath.join(f.root, `.app-builder/target-inputs/${digest}/repository/${specPath}`),
        "utf-8",
      ),
    ).toBe(accepted);
    await expect(recoverLegacyAppSpecTransport(f.input)).resolves.toEqual({
      status: "already-restored",
    });
  });

  it("restores the exact tracked preimage and executable mode", async () => {
    const f = fixture("canonical source markdown\n");
    await expect(recoverLegacyAppSpecTransport(f.input)).resolves.toEqual({ status: "restored" });
    expect(readFileSync(nodePath.join(f.checkout, specPath), "utf-8")).toBe(
      "canonical source markdown\n",
    );
    expect(git(f.checkout, "diff", "--", specPath)).toBe("");
  });

  it("preserves later user edits while retaining the exact accepted artifact externally", async () => {
    const f = fixture();
    writeFileSync(nodePath.join(f.checkout, specPath), "later authored markdown\n");
    await expect(recoverLegacyAppSpecTransport(f.input)).resolves.toEqual({ status: "preserved" });
    expect(readFileSync(nodePath.join(f.checkout, specPath), "utf-8")).toBe(
      "later authored markdown\n",
    );
    expect(
      readFileSync(
        nodePath.join(f.root, `.app-builder/target-inputs/${digest}/repository/${specPath}`),
        "utf-8",
      ),
    ).toBe(accepted);
  });

  it("does not infer absence when the recorded commit has a markdown preimage", async () => {
    const f = fixture("canonical source markdown\n");
    const marker = {
      platformFiles: [],
      receipt: f.input.baseline.receipt,
      unexposedReleasePrefixes: [],
    };
    marker.platformFiles = [];
    marker.receipt.platformSourceDigest = hash(JSON.stringify([]));
    const { digest: oldDigest, ...unsigned } = marker.receipt;
    expect(oldDigest).not.toBe("");
    marker.receipt.digest = hash(JSON.stringify(unsigned));
    f.input.baseline.receipt = marker.receipt;
    writeFileSync(f.markerPath, JSON.stringify(marker));
    await expect(recoverLegacyAppSpecTransport(f.input)).resolves.toEqual({ status: "preserved" });
    expect(readFileSync(nodePath.join(f.checkout, specPath), "utf-8")).toBe(accepted);
  });

  it("refuses cross-session baseline authority without changing source", async () => {
    const f = fixture();
    await expect(
      recoverLegacyAppSpecTransport({ ...f.input, sessionId: "other-session" }),
    ).rejects.toThrow("different Builder session");
    expect(readFileSync(nodePath.join(f.checkout, specPath), "utf-8")).toBe(accepted);
  });

  it("preserves source when accepted artifact bytes do not match the retained writer", async () => {
    const f = fixture();
    await expect(
      recoverLegacyAppSpecTransport({
        ...f.input,
        readAcceptedContent: async () => await Promise.resolve("other artifact"),
      }),
    ).resolves.toEqual({ status: "preserved" });
    expect(readFileSync(nodePath.join(f.checkout, specPath), "utf-8")).toBe(accepted);
  });
});

const compactionFixture = (transportPath = "prototype/demo/app-spec.md") => {
  const f = fixture();
  const planningRoot = planningOverlayRoot(digest);
  const absoluteRoot = nodePath.join(f.root, planningRoot);
  const staleFile = nodePath.join(absoluteRoot, "old-copy/source.ts");
  mkdirSync(nodePath.dirname(staleFile), { recursive: true });
  writeFileSync(staleFile, "derived source copy");
  const otherRevision = nodePath.join(f.root, planningOverlayRoot("c".repeat(64)), "retained");
  mkdirSync(nodePath.dirname(otherRevision), { recursive: true });
  writeFileSync(otherRevision, "other accepted revision");
  const candidate = nodePath.join(f.root, ".app-builder/draft-reconcile/retained");
  mkdirSync(candidate, { recursive: true });
  writeFileSync(nodePath.join(candidate, "repair"), "unpublished app repair");
  const workflow = {
    appSpec: { appId: "demo", artifactRevision: digest, digest: hash(accepted) },
    applyRoot: f.checkout,
    approval: { proposalDigest: "proposal" },
    candidateRoot: candidate,
    phase: "reviewed",
    proposal: {
      contract: { appSpec: { path: transportPath, sha256: hash(accepted) } },
      digest: "proposal",
    },
  };
  const input = {
    appId: workflow.appSpec.appId,
    appSpecDigest: workflow.appSpec.digest,
    artifactRevision: workflow.appSpec.artifactRevision,
    proposalAppSpec: workflow.proposal.contract.appSpec,
    readAcceptedContent: vi.fn().mockResolvedValue(accepted),
    retainedRoots: [workflow.applyRoot, workflow.candidateRoot],
    sandbox: f.input.sandbox,
  };
  return { ...f, absoluteRoot, candidate, input, otherRevision, planningRoot, staleFile, workflow };
};

describe("current accepted planning input compaction", () => {
  it.each(["prototype/demo/app-spec.md", ".config/app-specs/demo.md"])(
    "recreates exact accepted bytes at %s without changing working source or workflow authority",
    async (transportPath) => {
      const f = compactionFixture(transportPath);
      const before = structuredClone(f.workflow);
      await expect(compactAcceptedPlanningInput(f.input)).resolves.toEqual({ status: "compacted" });
      expect(existsSync(f.staleFile)).toBe(false);
      expect(readFileSync(nodePath.join(f.absoluteRoot, transportPath), "utf-8")).toBe(accepted);
      expect(
        readFileSync(nodePath.join(f.absoluteRoot, "prototype/demo/app-spec.md"), "utf-8"),
      ).toBe(accepted);
      expect(readFileSync(nodePath.join(f.checkout, "apps/demo/main.ts"), "utf-8")).toBe(
        "authored app\n",
      );
      expect(readFileSync(nodePath.join(f.candidate, "repair"), "utf-8")).toBe(
        "unpublished app repair",
      );
      expect(readFileSync(f.otherRevision, "utf-8")).toBe("other accepted revision");
      expect(f.workflow).toEqual(before);
    },
  );

  it("retains the original input if accepted inline content is unavailable or changed", async () => {
    const f = compactionFixture();
    const failure = new Error("accepted content unavailable");
    await expect(
      compactAcceptedPlanningInput({
        ...f.input,
        readAcceptedContent: vi.fn().mockRejectedValue(failure),
      }),
    ).rejects.toBe(failure);
    expect(readFileSync(f.staleFile, "utf-8")).toBe("derived source copy");
    await expect(
      compactAcceptedPlanningInput({
        ...f.input,
        readAcceptedContent: vi.fn().mockResolvedValue("different content"),
      }),
    ).rejects.toThrow("planning input was retained");
    expect(readFileSync(f.staleFile, "utf-8")).toBe("derived source copy");
  });

  it.each([false, true])(
    "verifies all durable chunks before removal (missing final chunk: %s)",
    async (missing) => {
      const f = compactionFixture();
      const path = "prototype/demo/app-spec.md";
      const artifact: PrototypeArtifactV2 = {
        appId: "demo",
        chunkCount: 2,
        contentBytes: Buffer.byteLength(accepted),
        digest: hash(accepted),
        mediaType: "text/markdown",
        path,
        recordedByCallId: "record",
        revision: hash(
          JSON.stringify({ digest: hash(accepted), mediaType: "text/markdown", path }),
        ),
        sessionId: "session",
        version: 2,
      };
      const split = 10;
      const chunks = [accepted.slice(0, split), accepted.slice(split)];
      const readAcceptedContent = async () => {
        const parts: Buffer[] = [];
        for await (const chunk of streamVerifiedPrototypeArtifact({
          artifact,
          readChunk: async (index) => {
            expect(existsSync(f.staleFile)).toBe(true);
            return missing && index === 1 ? undefined : chunks[index];
          },
        })) {
          parts.push(Buffer.from(chunk));
        }
        return Buffer.concat(parts).toString("utf-8");
      };
      const compact = compactAcceptedPlanningInput({ ...f.input, readAcceptedContent });
      if (missing) {
        await expect(compact).rejects.toThrow("missing chunk 1");
        expect(existsSync(f.staleFile)).toBe(true);
      } else {
        await expect(compact).resolves.toEqual({ status: "compacted" });
        expect(readFileSync(nodePath.join(f.absoluteRoot, path), "utf-8")).toBe(accepted);
      }
    },
  );

  it.each(["apply", "candidate", "validation", "completion"])(
    "retains a current planning root containing referenced %s working output",
    async () => {
      const f = compactionFixture();
      const readAcceptedContent = vi.fn().mockResolvedValue(accepted);
      await expect(
        compactAcceptedPlanningInput({
          ...f.input,
          readAcceptedContent,
          retainedRoots: [...f.input.retainedRoots, nodePath.join(f.absoluteRoot, "active-output")],
        }),
      ).resolves.toEqual({ status: "retained" });
      expect(readAcceptedContent).not.toHaveBeenCalled();
      expect(readFileSync(f.staleFile, "utf-8")).toBe("derived source copy");
    },
  );

  it("reports a failed exact restoration before continuing preparation", async () => {
    const f = compactionFixture();
    vi.spyOn(f.input.sandbox, "readBinaryFile").mockResolvedValue(Buffer.from("incomplete write"));
    await expect(compactAcceptedPlanningInput(f.input)).rejects.toThrow("not restored exactly");
    expect(readFileSync(nodePath.join(f.candidate, "repair"), "utf-8")).toBe(
      "unpublished app repair",
    );
  });
});
