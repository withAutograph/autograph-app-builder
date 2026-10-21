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
    rmSync(root, { recursive: true, force: true });
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
  const repository = { repositoryId: "100", owner: "example", name: "source" };
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
    JSON.stringify({ receipt, platformFiles, unexposedReleasePrefixes: [] }),
  );
  const unsignedApply: Omit<TargetApplyReceipt, "digest"> = {
    version: 2,
    status: "applied",
    sourceSha: sha,
    sourceTree: tree,
    sourceReceiptDigest: digest,
    eligibilityDigest: digest,
    workspaceDigest: digest,
    appSpecDigest: hash(accepted),
    appSpecPath: specPath,
    artifactRevision: digest,
    dependencyReceiptDigest: digest,
    identityDigest: digest,
    imageDigest: digest,
    dependencyCacheDigest: digest,
    dependencyCacheContentDigest: digest,
    proposalDigest: digest,
    applyRoot: checkout,
    planningTreeDigest: digest,
    preparedTreeDigest: digest,
    preTree: [],
    preTreeDigest: digest,
    command: {
      name: "iterate-existing-app",
      exitCode: 0,
      stdoutDigest: digest,
      stderrDigest: digest,
    },
    appliedByCallId: "apply",
    postTree: [{ path: specPath, mode: "644", digest: hash(accepted) }],
    postTreeDigest: digest,
    changes: [],
    changedContentDigest: digest,
    targetReceipt: {
      appId: "demo",
      mutations: ["apps/demo", "microfrontends.json"],
      omittedAuthorities: ["provider-provisioning", "deployment", "production-readiness"],
      recovered: false,
      topology: { path: "microfrontends.json", oldDigest: digest, newDigest: digest },
      version: 1,
      workspacePath: "apps/demo",
    },
  };
  const apply: TargetApplyReceipt = {
    ...unsignedApply,
    digest: hash(JSON.stringify(unsignedApply)),
  };
  writeFileSync(nodePath.join(checkout, specPath), accepted);
  chmodSync(nodePath.join(checkout, specPath), 0o644);
  const sandbox: SandboxSession = {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    spawn: vi.fn(),
    async writeTextFile({ path, content }) {
      const file = nodePath.join(root, path);
      await mkdir(nodePath.dirname(file), { recursive: true });
      await writeFile(file, content);
    },
    async removePath({ path, force, recursive }) {
      await rm(nodePath.join(root, path), { force, recursive });
    },
    resolvePath: (path) => nodePath.resolve(root, path),
    async readTextFile({ path }) {
      return await readFile(nodePath.join(root, path), "utf-8");
    },
    async readBinaryFile({ path }) {
      const file = nodePath.join(root, path);
      return existsSync(file) ? await readFile(file) : null;
    },
    async writeBinaryFile({ path, content }) {
      await writeFile(nodePath.join(root, path), content);
    },
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
      return { exitCode: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
    },
  };
  const input = {
    sandbox,
    sessionId: "session",
    repository,
    appId: "demo",
    artifactRevision: digest,
    appSpecDigest: hash(accepted),
    apply,
    baseline: { selection, receipt },
    workspaceRoot: root,
    readAcceptedContent: async () => await Promise.resolve(accepted),
  };
  return { root, checkout, input, markerPath };
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
      receipt: f.input.baseline.receipt,
      platformFiles: [],
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
    phase: "reviewed",
    proposal: {
      digest: "proposal",
      contract: { appSpec: { path: transportPath, sha256: hash(accepted) } },
    },
    approval: { proposalDigest: "proposal" },
    appSpec: { appId: "demo", artifactRevision: digest, digest: hash(accepted) },
    applyRoot: f.checkout,
    candidateRoot: candidate,
  };
  const input = {
    sandbox: f.input.sandbox,
    appId: workflow.appSpec.appId,
    artifactRevision: workflow.appSpec.artifactRevision,
    appSpecDigest: workflow.appSpec.digest,
    proposalAppSpec: workflow.proposal.contract.appSpec,
    retainedRoots: [workflow.applyRoot, workflow.candidateRoot],
    readAcceptedContent: () => Promise.resolve(accepted),
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
        readAcceptedContent: () => Promise.reject(failure),
      }),
    ).rejects.toBe(failure);
    expect(readFileSync(f.staleFile, "utf-8")).toBe("derived source copy");
    await expect(
      compactAcceptedPlanningInput({
        ...f.input,
        readAcceptedContent: () => Promise.resolve("different content"),
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
        version: 2,
        appId: "demo",
        path,
        digest: hash(accepted),
        revision: hash(
          JSON.stringify({ digest: hash(accepted), mediaType: "text/markdown", path }),
        ),
        mediaType: "text/markdown",
        chunkCount: 2,
        contentBytes: Buffer.byteLength(accepted),
        sessionId: "session",
        recordedByCallId: "record",
      };
      const split = 10;
      const chunks = [accepted.slice(0, split), accepted.slice(split)];
      const readAcceptedContent = async () => {
        const parts: Buffer[] = [];
        for await (const chunk of streamVerifiedPrototypeArtifact({
          artifact,
          readChunk: (index) => {
            expect(existsSync(f.staleFile)).toBe(true);
            return Promise.resolve(missing && index === 1 ? undefined : chunks[index]);
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
      const readAcceptedContent = vi.fn(() => Promise.resolve(accepted));
      await expect(
        compactAcceptedPlanningInput({
          ...f.input,
          retainedRoots: [...f.input.retainedRoots, nodePath.join(f.absoluteRoot, "active-output")],
          readAcceptedContent,
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
