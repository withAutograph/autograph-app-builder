import { describe, expect, it, vi } from "vitest";

import {
  candidateRuntimeCaptureFailureObservations,
  candidateRuntimeFailureObservations,
  evaluateCandidateRuntime,
} from "./self-reproduction-runtime";

function backend(results: { exitCode: number; stdout?: string; stderr?: string }[]) {
  const shutdown = vi.fn(() => Promise.resolve());
  const run = vi.fn(() => {
    const result = results.shift()!;
    return Promise.resolve({ stderr: "", stdout: "", ...result });
  });
  const writeTextFile = vi.fn(() => Promise.resolve());
  const writeBinaryFile = vi.fn(() => Promise.resolve());
  const spawn = vi.fn(() =>
    Promise.resolve({
      kill: () => Promise.resolve(),
      stderr: new ReadableStream(),
      stdout: new ReadableStream(),
      wait: () => Promise.resolve({ exitCode: 0 }),
    }),
  );
  return {
    backend: {
      create: () =>
        Promise.resolve({
          captureState: () =>
            Promise.resolve({ backendName: "fixture", metadata: {}, sessionKey: "fixture" }),
          session: {
            id: "sandbox-fixture",
            run,
            spawn,
            writeBinaryFile,
            readTextFile: () => Promise.resolve(JSON.stringify({ basePath: "" })),
            writeTextFile,
          },
          shutdown,
          stop: () => Promise.resolve(),
          useSessionFn: () => {
            throw new Error("unused");
          },
        }),
      name: "fixture",
      prewarm: () => Promise.resolve({ reused: false }),
    } as never,
    run,
    shutdown,
    spawn,
    writeBinaryFile,
    writeTextFile,
  };
}

describe("self-reproduction candidate runtime", () => {
  it("turns a candidate build failure into failed evidence for every in-scope requirement", () => {
    const observations = candidateRuntimeFailureObservations({
      existingRequirementIds: new Set(["documentation"]),
      receipt: { reason: "Candidate build failed.", status: "failed" },
    });

    expect(observations).not.toHaveLength(0);
    expect(observations).not.toContainEqual(
      expect.objectContaining({ requirementId: "anonymous-entry" }),
    );
    expect(observations).not.toContainEqual(
      expect.objectContaining({ requirementId: "documentation" }),
    );
    expect(observations).toContainEqual(
      expect.objectContaining({
        artifacts: ["candidate-runtime.json"],
        disposition: "missing-functionality",
        requirementId: "durable-draft",
      }),
    );
    expect(observations.some((item) => item.requirementId.startsWith("capture/"))).toBe(false);
    const captures = candidateRuntimeCaptureFailureObservations({
      receipt: { reason: "Candidate build failed.", status: "failed" },
    });
    expect(captures).toContainEqual(
      expect.objectContaining({
        disposition: "missing-functionality",
        requirementId: "capture/desktop/error",
      }),
    );
    expect(captures.every((item) => item.requirementId.startsWith("capture/"))).toBe(true);
  });

  it("classifies runtime infrastructure loss as blocked evidence", () => {
    const observations = candidateRuntimeFailureObservations({
      receipt: {
        commands: [],
        probes: [],
        producer: "evaluator",
        reason: "Vercel Sandbox unavailable.",
        status: "infrastructure-unavailable",
      },
    });

    expect(observations).not.toHaveLength(0);
    expect(observations.every((item) => item.disposition === "infrastructure-unavailable")).toBe(
      true,
    );
  });

  it("starts a validated candidate and retains evaluator HTTP probes", async () => {
    const fixture = backend([
      { exitCode: 0 },
      { exitCode: 0 },
      { exitCode: 0 },
      { exitCode: 0 },
      { exitCode: 0 },
      { exitCode: 0 },
      {
        exitCode: 0,
        stdout: JSON.stringify([
          {
            detail: "ok",
            disposition: "observed",
            id: "root",
            method: "http",
            passed: true,
            status: 200,
            url: "http://127.0.0.1:3000/candidate",
          },
        ]),
      },
      { exitCode: 0 },
      {
        exitCode: 0,
        stdout: JSON.stringify([
          {
            detail: "ok",
            disposition: "observed",
            id: "documentation",
            method: "browser",
            passed: true,
            status: 200,
            url: "http://127.0.0.1:3000/candidate/docs",
          },
        ]),
      },
    ]);
    const onReady = vi.fn(({ baseURL }: { baseURL: string }) => {
      expect(baseURL).toBe("http://127.0.0.1:3000");
      expect(fixture.shutdown).not.toHaveBeenCalled();
      return Promise.resolve();
    });
    const receipt = await evaluateCandidateRuntime({
      backend: fixture.backend,
      candidateAppId: "candidate",
      files: [{ content: "{}", path: "package.json" }],
      publicBasePath: "/candidate",
      onReady,
      workspaceArchive: Buffer.from("archive"),
    });
    expect(receipt).toMatchObject({ producer: "evaluator", status: "available" });
    expect(receipt.probes).toHaveLength(2);
    expect(fixture.writeBinaryFile).toHaveBeenCalledOnce();
    expect(fixture.writeTextFile).toHaveBeenCalledTimes(6);
    expect(fixture.spawn).toHaveBeenCalledOnce();
    expect(fixture.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.stringContaining("PORT=3000"),
      }),
    );
    expect(fixture.shutdown).toHaveBeenCalledOnce();
    expect(onReady).toHaveBeenCalledOnce();
  });

  it("retains build diagnostics and never starts a failed candidate", async () => {
    const fixture = backend([
      { exitCode: 0 },
      { exitCode: 0 },
      { exitCode: 0 },
      { exitCode: 0 },
      { exitCode: 0 },
      { exitCode: 1, stderr: "Type error in app/page.tsx" },
    ]);
    const receipt = await evaluateCandidateRuntime({
      backend: fixture.backend,
      candidateAppId: "candidate",
      files: [],
      publicBasePath: "/candidate",
      workspaceArchive: Buffer.from("archive"),
    });
    expect(receipt).toMatchObject({ reason: "Candidate build failed.", status: "failed" });
    expect(receipt.commands[5]?.stderr).toContain("Type error");
    expect(fixture.spawn).not.toHaveBeenCalled();
    expect(fixture.shutdown).toHaveBeenCalledOnce();
  });

  it("classifies provider creation failure as unavailable infrastructure", async () => {
    const receipt = await evaluateCandidateRuntime({
      backend: {
        create: () => Promise.reject(new Error("Vercel OIDC credential unavailable")),
        name: "fixture",
        prewarm: () => Promise.resolve({ reused: false }),
      },
      candidateAppId: "candidate",
      files: [],
      publicBasePath: "/candidate",
      workspaceArchive: Buffer.from("archive"),
    });
    expect(receipt).toMatchObject({ probes: [], status: "infrastructure-unavailable" });
  });

  it("never treats a successful diagnostic rebuild as production acceptance", async () => {
    const fixture = backend([
      ...Array.from({ length: 5 }, () => ({ exitCode: 0 })),
      { exitCode: 1, stderr: "Expected workStore to be initialized" },
      { exitCode: 0, stdout: "Diagnostic build complete" },
    ]);
    const receipt = await evaluateCandidateRuntime({
      backend: fixture.backend,
      workspaceArchive: Buffer.from("archive"),
      candidateAppId: "candidate",
      publicBasePath: "/candidate",
      files: [],
      debugPrerender: true,
    });
    expect(receipt.status).toBe("failed");
    expect(receipt.commands.at(-1)?.command).toContain("--debug-prerender");
    expect(receipt.commands.at(-1)?.stdout).toContain("Diagnostic build complete");
    expect(fixture.spawn).not.toHaveBeenCalled();
    expect(fixture.shutdown).toHaveBeenCalledOnce();
  });
});
