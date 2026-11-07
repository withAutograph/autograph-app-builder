import { describe, expect, it, vi } from "vitest";
import type { CandidateRuntimeSandbox } from "./self-reproduction-runtime";

import {
  candidateRuntimeCaptureFailureObservations,
  candidateRuntimeFailureObservations,
  evaluateCandidateRuntime,
} from "./self-reproduction-runtime";

const backend = (results: { exitCode: number; stdout?: string; stderr?: string }[]) => {
  const shutdown = vi.fn(async () => {
    await Promise.resolve();
  });
  const run = vi.fn(async () => {
    await Promise.resolve();
    const result = results.shift();
    if (!result) {
      throw new Error("Runtime backend fixture was exhausted.");
    }
    return { stderr: "", stdout: "", ...result };
  });
  const writeTextFile = vi.fn(async () => {
    await Promise.resolve();
  });
  const writeBinaryFile = vi.fn(async () => {
    await Promise.resolve();
  });
  const spawn = vi.fn(async () => {
    await Promise.resolve();
    return {
      kill: async () => {
        await Promise.resolve();
      },
      stderr: new ReadableStream(),
      stdout: new ReadableStream(),
      wait: async () => await Promise.resolve({ exitCode: 0 }),
    };
  });
  return {
    backend: {
      open: async () =>
        await Promise.resolve({
          id: "sandbox-fixture",
          session: {
            id: "sandbox-fixture",
            readTextFile: async () => {
              await Promise.resolve();
              return JSON.stringify({ basePath: "" });
            },
            run,
            spawn,
            writeBinaryFile,
            writeTextFile,
          },
          shutdown,
        }),
    } satisfies { open: () => Promise<CandidateRuntimeSandbox> },
    run,
    shutdown,
    spawn,
    writeBinaryFile,
    writeTextFile,
  };
};

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
    const onReady = vi.fn(async ({ baseURL }: { baseURL: string }) => {
      expect(baseURL).toBe("http://127.0.0.1:3000");
      expect(fixture.shutdown).not.toHaveBeenCalled();
      await Promise.resolve();
    });
    const receipt = await evaluateCandidateRuntime({
      backend: fixture.backend,
      candidateAppId: "candidate",
      files: [{ content: "{}", path: "package.json" }],
      onReady,
      publicBasePath: "/candidate",
      workspaceArchive: Buffer.from("archive"),
    });
    expect(receipt).toMatchObject({ producer: "evaluator", status: "available" });
    expect(receipt.probes).toHaveLength(2);
    expect(fixture.writeBinaryFile).toHaveBeenCalledOnce();
    expect(fixture.writeTextFile).toHaveBeenCalledTimes(6);
    expect(fixture.spawn).toHaveBeenCalledOnce();
    expect(fixture.spawn.mock.calls[0]?.[0]?.command).toContain("PORT=3000");
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
        open: async () => {
          await Promise.reject(new Error("Vercel OIDC credential unavailable"));
        },
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
      candidateAppId: "candidate",
      debugPrerender: true,
      files: [],
      publicBasePath: "/candidate",
      workspaceArchive: Buffer.from("archive"),
    });
    expect(receipt.status).toBe("failed");
    expect(receipt.commands.at(-1)?.command).toContain("--debug-prerender");
    expect(receipt.commands.at(-1)?.stdout).toContain("Diagnostic build complete");
    expect(fixture.spawn).not.toHaveBeenCalled();
    expect(fixture.shutdown).toHaveBeenCalledOnce();
  });
});
