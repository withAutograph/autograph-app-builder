/* oxlint-disable eslint/require-await -- async fixtures implement Sandbox and browser APIs. */
import { describe, expect, it, vi } from "vitest";
import { runSandboxRuntimeComparison } from "./self-reproduction-runtime-comparison";

function fixture(exitCode = 0) {
  return {
    writeTextFile: vi.fn(async () => {}),
    run: vi.fn(async () => ({
      exitCode,
      stdout: "diagnostic stdout",
      stderr: "diagnostic stderr",
    })),
    readTextFile: vi.fn(async () => '{"observations":[]}'),
    readBinaryFile: vi.fn(async () => new Uint8Array([1, 2])),
  };
}

describe("live sandbox comparison", () => {
  it("stages evaluator input as data and collects output and screenshots", async () => {
    const session = fixture();
    const payload = { baseURL: "http://127.0.0.1:3000", text: "$(secret) `command`" };
    const result = await runSandboxRuntimeComparison({
      session: session as never,
      script: "// evaluator",
      payload,
      artifactPaths: ["screenshots/root.png"],
      abortSignal: new AbortController().signal,
    });
    expect(result.status).toBe("completed");
    expect(result.output).toEqual({ observations: [] });
    expect(result.artifacts[0]?.content).toEqual(new Uint8Array([1, 2]));
    expect(session.writeTextFile).toHaveBeenCalledWith({
      path: expect.stringMatching(/^\.self-reproduction-comparison\/[^/]+\/input\.json$/u),
      content: JSON.stringify(payload),
    });
    expect(session.run.mock.calls[0]).not.toContain(payload.text);
  });

  it("retains partial output and successful artifacts after evaluator and artifact failures", async () => {
    const session = fixture(1);
    session.readBinaryFile.mockRejectedValueOnce(new Error("screenshot missing"));
    const result = await runSandboxRuntimeComparison({
      session: session as never,
      script: "// evaluator",
      payload: {},
      artifactPaths: ["missing.png", "present.png"],
      abortSignal: new AbortController().signal,
    });
    expect(result.status).toBe("failed");
    expect(result.command.stderr).toBe("diagnostic stderr");
    expect(result.output).toEqual({ observations: [] });
    expect(result.artifacts.map(({ path }) => path)).toEqual(["present.png"]);
    expect(result.errors).toEqual([
      "Evaluator exited with code 1.",
      "Artifact missing.png: screenshot missing",
    ]);
  });

  it("never recovers earlier probe files when the next probe fails before writing", async () => {
    const files = new Map<string, string>();
    const artifacts = new Map<string, Uint8Array>();
    let invocation = 0;
    const session = {
      writeTextFile: vi.fn(async ({ path, content }: { path: string; content: string }) => {
        files.set(path, content);
      }),
      run: vi.fn(async ({ command }: { command: string }) => {
        invocation += 1;
        if (invocation === 2) throw new Error("second probe failed before writing");
        const outputPath = command.split(" ").at(-1)!;
        files.set(outputPath, JSON.stringify({ probe: invocation }));
        artifacts.set(outputPath.replace("output.json", "capture.png"), new Uint8Array([1]));
        return { exitCode: 0, stdout: "", stderr: "" };
      }),
      readTextFile: vi.fn(async ({ path }: { path: string }) => files.get(path) ?? null),
      readBinaryFile: vi.fn(async ({ path }: { path: string }) => artifacts.get(path) ?? null),
    };
    const input = {
      session: session as never,
      script: "// evaluator",
      payload: {},
      artifactPaths: ["capture.png"],
      abortSignal: new AbortController().signal,
    };
    const first = await runSandboxRuntimeComparison(input);
    const second = await runSandboxRuntimeComparison(input);
    expect(first.status).toBe("completed");
    expect(first.output).toEqual({ probe: 1 });
    expect(first.artifacts).toHaveLength(1);
    expect(second.status).toBe("failed");
    expect(second.output).toBeNull();
    expect(second.artifacts).toEqual([]);
    expect(second.errors).toEqual([
      "second probe failed before writing",
      "Comparison output: Evaluator output file is missing.",
      "Artifact capture.png: Evaluator artifact file is missing.",
    ]);
  });

  it("rejects artifact paths outside the evaluator directory", async () => {
    const session = fixture();
    await expect(
      runSandboxRuntimeComparison({
        session: session as never,
        script: "",
        payload: {},
        artifactPaths: ["../credential"],
        abortSignal: new AbortController().signal,
      }),
    ).rejects.toThrow("relative child path");
    expect(session.run).not.toHaveBeenCalled();
  });
});
