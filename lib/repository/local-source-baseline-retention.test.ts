import { beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { inspectDevelopmentSourceGeneration } from "./supported-template";
import { captureLocalPlanningSource } from "./local-planning-source";
import { localSourceBaselineManifestSchema } from "./local-source-baseline-contract";
import { retainPreparedLocalSourceBaseline } from "./local-source-baseline-retention";

const mock = { authority: vi.fn(), capture: vi.fn(), retain: vi.fn() };
const dependencies = { readAuthority: mock.authority, capture: mock.capture, retain: mock.retain };
const expected = {
  sourcePath: "/owned/live",
  sourceSha: "a".repeat(40),
  eligibilityDigest: "b".repeat(64),
  names: ["source.ts"],
  sourceFiles: [
    {
      mode: "100644" as const,
      objectId: "c".repeat(40),
      path: "source.ts",
      sha256: "c".repeat(64),
    },
  ],
  workspaceDigest: "d".repeat(64),
  generation: "d".repeat(40),
};
describe("retained first local planning baseline", () => {
  beforeEach(() => vi.resetAllMocks());
  it("retains actual captured bytes and historical identity before accepting preparation", async () => {
    const authority = { kind: "local", ownerUid: 501, stateRoot: "/owned/state" };
    mock.authority.mockResolvedValue(authority);
    const pack = new ReadableStream<Uint8Array>();
    const dispose = vi.fn();
    mock.capture.mockResolvedValue({
      generation: expected,
      capturedBase: () => ({
        sourceSha: "e".repeat(40),
        sourceTree: "f".repeat(40),
        streamPack: () => pack,
      }),
      dispose,
    });
    await retainPreparedLocalSourceBaseline(expected, dependencies);
    expect(mock.capture).toHaveBeenCalledWith(expected.sourcePath, expected.sourceSha);
    expect(mock.retain).toHaveBeenCalledWith({
      authority,
      manifest: {
        version: 1,
        kind: "local-planning-source-baseline",
        originalSourceSha: expected.sourceSha,
        workspaceDigest: expected.workspaceDigest,
        sourceSha: "e".repeat(40),
        sourceTree: "f".repeat(40),
        provenance: { kind: "captured-live-source", sourcePath: expected.sourcePath },
      },
      pack,
    });
    expect(dispose).toHaveBeenCalledOnce();
  });
  it("retains an already verified reconciliation capture without rereading or disposing its owner's bytes", async () => {
    mock.authority.mockResolvedValue({ kind: "local", ownerUid: 501, stateRoot: "/owned/state" });
    const dispose = vi.fn();
    const pack = new ReadableStream<Uint8Array>();
    const captured = {
      generation: expected,
      capturedBase: () => ({
        sourceSha: "e".repeat(40),
        sourceTree: "f".repeat(40),
        streamPack: () => pack,
      }),
      dispose,
    };
    await retainPreparedLocalSourceBaseline(expected, { ...dependencies, captured });
    expect(mock.capture).not.toHaveBeenCalled();
    expect(mock.retain).toHaveBeenCalledOnce();
    expect(dispose).not.toHaveBeenCalled();
  });

  it("does not freeze an original baseline if the actual selected source moved", async () => {
    mock.authority.mockResolvedValue({ kind: "local", ownerUid: 501, stateRoot: "/owned/state" });
    const dispose = vi.fn();
    mock.capture.mockResolvedValue({
      generation: { ...expected, workspaceDigest: "f".repeat(64) },
      dispose,
    });
    await expect(retainPreparedLocalSourceBaseline(expected, dependencies)).rejects.toThrow(
      "changed before its original baseline",
    );
    expect(mock.retain).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
  });
  it("does not introduce local authority in hosted or ordinary source preparation", async () => {
    // oxlint-disable-next-line unicorn/no-useless-undefined -- Explicitly simulate absent local authority.
    mock.authority.mockResolvedValueOnce(undefined);
    await retainPreparedLocalSourceBaseline(expected, dependencies);
    expect(mock.capture).not.toHaveBeenCalled();
    expect(mock.retain).not.toHaveBeenCalled();
  });
  it("round-trips a real dirty initial source through the immutable store and later baseline recovery", async () => {
    const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "retained-first-source-")));
    const source = path.join(directory, "source");
    const stateRoot = path.join(directory, "state");
    mkdirSync(source, { mode: 0o700 });
    mkdirSync(stateRoot, { mode: 0o700 });
    const git = (...args: string[]) =>
      execFileSync(
        "/usr/bin/git",
        ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-C", source, ...args],
        { encoding: "utf-8" },
      ).trim();
    let capture: Awaited<ReturnType<typeof captureLocalPlanningSource>> | undefined;
    try {
      git("init", "--quiet");
      git("config", "user.name", "Fixture");
      git("config", "user.email", "fixture@example.test");
      writeFileSync(path.join(source, "source.txt"), "first\n");
      git("add", ".");
      git("commit", "--quiet", "-m", "parent");
      writeFileSync(path.join(source, "source.txt"), "second\n");
      git("add", ".");
      git("commit", "--quiet", "-m", "historical original");
      writeFileSync(path.join(source, "dirty.txt"), "actual initial dirty bytes\n");
      const initial = await inspectDevelopmentSourceGeneration(source);
      const authority = { kind: "local" as const, ownerUid: process.getuid?.() ?? -1, stateRoot };
      // oxlint-disable-next-line typescript/promise-function-async -- Preserve the returned promise and synchronous throw behavior.
      const readAuthority = () => Promise.resolve(authority);
      await retainPreparedLocalSourceBaseline(initial, { readAuthority });
      const manifestPath = path.join(
        stateRoot,
        "source-baselines",
        initial.sourceSha,
        initial.workspaceDigest,
        "manifest.json",
      );
      const manifest = localSourceBaselineManifestSchema.parse(
        JSON.parse(readFileSync(manifestPath, "utf-8")),
      );
      expect(manifest.originalSourceSha).toBe(initial.sourceSha);
      expect(manifest.sourceSha).not.toBe(initial.sourceSha);
      writeFileSync(path.join(source, "dirty.txt"), "current newer platform bytes\n");
      capture = await captureLocalPlanningSource(source, initial.sourceSha, { readAuthority });
      expect(capture.originalBase(initial.workspaceDigest).sourceSha).toBe(manifest.sourceSha);
    } finally {
      capture?.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
