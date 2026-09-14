import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createAutomaticPreviewObserver } from "../evals/support/self-reproduction-auto-preview";
import { runPublicSession } from "../evals/support/self-reproduction-public";
import type { PublicState } from "../evals/support/self-reproduction-public";

const directories: string[] = [];
const directory = () => {
  const value = mkdtempSync(path.join(tmpdir(), "preview-observer-"));
  directories.push(value);
  return value;
};
afterEach(() => {
  for (const value of directories.splice(0)) {
    rmSync(value, { force: true, recursive: true });
  }
});
const state = (): PublicState => ({
  answered: [],
  clientRequestId: "start",
  endpoint: "http://localhost:64613/mcp",
  outcome: "working",
  prompt: "full brief",
  session: {
    cursor: 1,
    events: [],
    inputRequests: [],
    sessionId: "one",
    status: "working",
    workingPreview: {
      appId: "app",
      expiresAt: "2099-01-01T00:00:00.000Z",
      status: "ready",
      url: "https://preview.example/private-secret",
      verifiedAt: "2026-09-14T00:00:00.000Z",
    },
  },
  startedAt: new Date().toISOString(),
  version: 1,
});
it("starts capture without waiting for public polling and preserves private receipt separately", async () => {
  const outputDir = directory();
  const pending = Promise.withResolvers<number>();
  const execute = vi.fn(async () => await pending.promise);
  const observer = createAutomaticPreviewObserver({
    execute,
    outputDir,
    repositoryRoot: "/reference",
  });
  const current = state();
  observer.observe(current);
  await Promise.resolve();
  expect(execute).toHaveBeenCalledTimes(1);
  const [invocation] = execute.mock.calls;
  expect(invocation).toBeDefined();
  expect(
    readFileSync(path.join(outputDir, "preview-observations/ledger.json"), "utf-8"),
  ).not.toContain("private-secret");
  pending.resolve(0);
  await observer.finish();
  observer.observe(current);
  const resumed = createAutomaticPreviewObserver({
    execute,
    outputDir,
    repositoryRoot: "/reference",
  });
  resumed.observe(current);
  await resumed.finish();
  expect(execute).toHaveBeenCalledTimes(1);
});
it("preserves expired and failed captures without changing session outcomes", async () => {
  const outputDir = directory();
  const execute = vi.fn(async () => {
    await Promise.resolve();
    throw new Error("private-secret");
  });
  const observer = createAutomaticPreviewObserver({
    execute,
    outputDir,
    repositoryRoot: "/reference",
  });
  const current = state();
  observer.observe(current);
  await observer.finish();
  expect(current.outcome).toBe("working");
  const expired = createAutomaticPreviewObserver({
    execute,
    now: () => Date.parse("2100-01-01"),
    outputDir: directory(),
    repositoryRoot: "/reference",
  });
  expired.observe(current);
  await expired.finish();
  expect(execute).toHaveBeenCalledTimes(1);
  const ledger = readFileSync(path.join(outputDir, "preview-observations/ledger.json"), "utf-8");
  expect(ledger).toContain("failed");
  expect(ledger).not.toContain("private-secret");
});
it("captures while an ordinary approval remains unanswered, without extra MCP calls", async () => {
  const current = state();
  delete current.session;
  const calls: string[] = [];
  const execute = vi.fn(async () => {
    await Promise.resolve();
    return 0;
  });
  const observer = createAutomaticPreviewObserver({
    execute,
    outputDir: directory(),
    repositoryRoot: "/reference",
  });
  const delivered = state().session;
  await runPublicSession({
    onObservation: observer.observe,
    pollMs: 1,
    save: () => {},
    state: current,
    timeoutMs: 1000,
    transport: {
      call: async (name) => {
        await Promise.resolve();
        calls.push(name);
        return {
          ...delivered,
          inputRequests: [
            { allowFreeform: false, kind: "approval", requestId: "build", title: "Build?" },
          ],
          status: "input_required",
        };
      },
    },
  });
  await observer.finish();
  expect(calls).toEqual(["autograph_start"]);
  expect(current.outcome).toBe("input_required");
  expect(current.answered).toEqual([]);
  expect(execute).toHaveBeenCalledTimes(1);
});

it("preserves interrupted captures as incomplete on resume without launching duplicates", async () => {
  const outputDir = directory();
  const pending = Promise.withResolvers<number>();
  const execute = vi.fn(async () => await pending.promise);
  const observer = createAutomaticPreviewObserver({
    execute,
    outputDir,
    repositoryRoot: "/reference",
  });
  observer.observe(state());
  const resumed = createAutomaticPreviewObserver({
    execute,
    outputDir,
    repositoryRoot: "/reference",
  });
  resumed.observe(state());
  await resumed.finish();
  expect(execute).toHaveBeenCalledTimes(1);
  const ledgerFile = path.join(outputDir, "preview-observations/ledger.json");
  expect(readFileSync(ledgerFile, "utf-8")).toContain("incomplete");
  pending.resolve(0);
  await observer.finish();
  writeFileSync(ledgerFile, "invalid ledger");
  const invalid = createAutomaticPreviewObserver({
    execute,
    outputDir,
    repositoryRoot: "/reference",
  });
  expect(() => {
    invalid.observe(state());
  }).not.toThrow();
  expect(
    readFileSync(path.join(outputDir, "preview-observations/observer-error.json"), "utf-8"),
  ).toContain("incomplete");
});

it("bounds a hanging executor, signals owned cleanup and keeps minimal snapshots", async () => {
  const outputDir = directory();
  const pending = Promise.withResolvers<number>();
  let aborted = false;
  const observer = createAutomaticPreviewObserver({
    execute: async (invocation) => {
      const snapshot = readFileSync(invocation.stateFile, "utf-8");
      expect(snapshot).not.toContain("full brief");
      expect(snapshot).not.toContain("clientRequestId");
      expect(snapshot).toContain("private-secret");
      expect(path.dirname(invocation.stateFile)).not.toBe(invocation.outputDir);
      invocation.signal.addEventListener("abort", () => {
        aborted = true;
      });
      return await pending.promise;
    },
    outputDir,
    repositoryRoot: "/reference",
    timeoutMs: 10,
  });
  const current = state();
  observer.observe(current);
  await observer.finish();
  expect(aborted).toBe(true);
  expect(current.outcome).toBe("working");
  const ledger = readFileSync(path.join(outputDir, "preview-observations/ledger.json"), "utf-8");
  expect(ledger).toContain("timed_out");
  expect(ledger).toContain('"exitCode": null');
  expect(ledger).toContain("finishedAt");
  expect(ledger).toContain("capture/report.json");
  expect(ledger).not.toContain("private-secret");
  expect(readFileSync(path.join(outputDir, "preview-observations/index.html"), "utf-8")).toContain(
    "Capture report",
  );
});
