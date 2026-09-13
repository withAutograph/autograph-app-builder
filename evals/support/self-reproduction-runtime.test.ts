import { describe, expect, it, vi } from "vitest";

import { evaluateCandidateRuntime } from "./self-reproduction-runtime";

function backend(results: { exitCode: number; stdout?: string; stderr?: string }[]) {
  const shutdown = vi.fn(() => Promise.resolve());
  const run = vi.fn(() => {
    const result = results.shift()!;
    return Promise.resolve({ stdout: "", stderr: "", ...result });
  });
  const writeTextFile = vi.fn(() => Promise.resolve());
  const spawn = vi.fn(() =>
    Promise.resolve({
      stdout: new ReadableStream(),
      stderr: new ReadableStream(),
      wait: () => Promise.resolve({ exitCode: 0 }),
      kill: () => Promise.resolve(),
    }),
  );
  return {
    backend: {
      name: "fixture",
      prewarm: () => Promise.resolve({ reused: false }),
      create: () =>
        Promise.resolve({
          session: {
            id: "sandbox-fixture",
            run,
            spawn,
            writeTextFile,
          },
          useSessionFn: () => {
            throw new Error("unused");
          },
          captureState: () =>
            Promise.resolve({ backendName: "fixture", metadata: {}, sessionKey: "fixture" }),
          stop: () => Promise.resolve(),
          shutdown,
        }),
    } as never,
    run,
    spawn,
    writeTextFile,
    shutdown,
  };
}

describe("self-reproduction candidate runtime", () => {
  it("starts a validated candidate and retains evaluator HTTP probes", async () => {
    const fixture = backend([
      { exitCode: 0 },
      { exitCode: 0 },
      {
        exitCode: 0,
        stdout: JSON.stringify([
          { id: "root", url: "http://127.0.0.1:3000/", status: 200, passed: true, detail: "ok" },
          {
            id: "documentation",
            url: "http://127.0.0.1:3000/docs",
            status: 200,
            passed: true,
            detail: "ok",
          },
        ]),
      },
    ]);
    const receipt = await evaluateCandidateRuntime({
      backend: fixture.backend,
      files: [{ path: "package.json", content: "{}" }],
      baseFiles: [{ path: "package.json", content: '{"workspaces":["apps/*"]}' }],
      candidateAppId: "replica",
    });
    expect(receipt).toMatchObject({ producer: "evaluator", status: "available" });
    expect(receipt.probes).toHaveLength(2);
    expect(fixture.writeTextFile).toHaveBeenCalledTimes(2);
    expect(fixture.spawn).toHaveBeenCalledOnce();
    expect(fixture.shutdown).toHaveBeenCalledOnce();
  });

  it("retains build diagnostics and never starts a failed candidate", async () => {
    const fixture = backend([
      { exitCode: 0 },
      { exitCode: 1, stderr: "Type error in app/page.tsx" },
    ]);
    const receipt = await evaluateCandidateRuntime({
      backend: fixture.backend,
      files: [],
      baseFiles: [],
      candidateAppId: "replica",
    });
    expect(receipt).toMatchObject({ status: "failed", reason: "Candidate build failed." });
    expect(receipt.commands[1]?.stderr).toContain("Type error");
    expect(fixture.spawn).not.toHaveBeenCalled();
    expect(fixture.shutdown).toHaveBeenCalledOnce();
  });

  it("classifies provider creation failure as unavailable infrastructure", async () => {
    const receipt = await evaluateCandidateRuntime({
      backend: {
        name: "fixture",
        prewarm: () => Promise.resolve({ reused: false }),
        create: () => Promise.reject(new Error("Vercel OIDC credential unavailable")),
      },
      files: [],
      baseFiles: [],
      candidateAppId: "replica",
    });
    expect(receipt).toMatchObject({ status: "infrastructure-unavailable", probes: [] });
  });
});
