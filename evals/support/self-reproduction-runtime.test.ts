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
    return Promise.resolve({ stdout: "", stderr: "", ...result });
  });
  const writeTextFile = vi.fn(() => Promise.resolve());
  const writeBinaryFile = vi.fn(() => Promise.resolve());
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
            writeBinaryFile,
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
    writeBinaryFile,
    shutdown,
  };
}

describe("self-reproduction candidate runtime", () => {
  it("turns a candidate build failure into failed evidence for every in-scope requirement", () => {
    const observations = candidateRuntimeFailureObservations({
      receipt: { status: "failed", reason: "Candidate build failed." },
      existingRequirementIds: new Set(["documentation"]),
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
        requirementId: "durable-draft",
        disposition: "missing-functionality",
        artifacts: ["candidate-runtime.json"],
      }),
    );
    expect(observations.some((item) => item.requirementId.startsWith("capture/"))).toBe(false);
    const captures = candidateRuntimeCaptureFailureObservations({
      receipt: { status: "failed", reason: "Candidate build failed." },
    });
    expect(captures).toContainEqual(
      expect.objectContaining({
        requirementId: "capture/desktop/error",
        disposition: "missing-functionality",
      }),
    );
    expect(captures.every((item) => item.requirementId.startsWith("capture/"))).toBe(true);
  });

  it("classifies runtime infrastructure loss as blocked evidence", () => {
    const observations = candidateRuntimeFailureObservations({
      receipt: {
        producer: "evaluator",
        status: "infrastructure-unavailable",
        reason: "Vercel Sandbox unavailable.",
        commands: [],
        probes: [],
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
            id: "root",
            url: "http://127.0.0.1:3000/candidate",
            status: 200,
            passed: true,
            detail: "ok",
            method: "http",
            disposition: "observed",
          },
        ]),
      },
      {
        exitCode: 0,
        stdout: JSON.stringify([
          {
            id: "documentation",
            url: "http://127.0.0.1:3000/candidate/docs",
            status: 200,
            passed: true,
            detail: "ok",
            method: "browser",
            disposition: "observed",
          },
        ]),
      },
    ]);
    const receipt = await evaluateCandidateRuntime({
      backend: fixture.backend,
      workspaceArchive: Buffer.from("archive"),
      candidateAppId: "candidate",
      publicBasePath: "/candidate",
      files: [{ path: "package.json", content: "{}" }],
    });
    expect(receipt).toMatchObject({ producer: "evaluator", status: "available" });
    expect(receipt.probes).toHaveLength(2);
    expect(fixture.writeBinaryFile).toHaveBeenCalledOnce();
    expect(fixture.writeTextFile).toHaveBeenCalledTimes(4);
    expect(fixture.spawn).toHaveBeenCalledOnce();
    expect(fixture.shutdown).toHaveBeenCalledOnce();
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
      workspaceArchive: Buffer.from("archive"),
      candidateAppId: "candidate",
      publicBasePath: "/candidate",
      files: [],
    });
    expect(receipt).toMatchObject({ status: "failed", reason: "Candidate build failed." });
    expect(receipt.commands[5]?.stderr).toContain("Type error");
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
      workspaceArchive: Buffer.from("archive"),
      candidateAppId: "candidate",
      publicBasePath: "/candidate",
      files: [],
    });
    expect(receipt).toMatchObject({ status: "infrastructure-unavailable", probes: [] });
  });
});
