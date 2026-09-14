/* oxlint-disable eslint/require-await -- async fixtures implement Sandbox and browser APIs. */
import { describe, expect, it, vi } from "vitest";
import { runSandboxRuntimeComparison } from "./self-reproduction-runtime-comparison";

const fixture = (exitCode = 0) => ({
  readBinaryFile: vi.fn(async () => new Uint8Array([1, 2])),
  readTextFile: vi.fn(async () => '{"observations":[]}'),
  run: vi.fn(async () => ({
    exitCode,
    stderr: "diagnostic stderr",
    stdout: "diagnostic stdout",
  })),
  writeTextFile: vi.fn(async () => {}),
});

describe("live sandbox comparison", () => {
  it("stages evaluator input as data and collects output and screenshots", async () => {
    const session = fixture();
    const payload = { baseURL: "http://127.0.0.1:3000", text: "$(secret) `command`" };
    const result = await runSandboxRuntimeComparison({
      abortSignal: new AbortController().signal,
      artifactPaths: ["screenshots/root.png"],
      payload,
      script: "// evaluator",
      session: session as never,
    });
    expect(result.status).toBe("completed");
    expect(result.output).toEqual({ observations: [] });
    expect(result.artifacts[0]?.content).toEqual(new Uint8Array([1, 2]));
    expect(session.writeTextFile).toHaveBeenCalledWith({
      content: JSON.stringify(payload),
      path: expect.stringMatching(/^\.self-reproduction-comparison\/[^/]+\/input\.json$/u),
    });
    expect(session.run.mock.calls[0]).not.toContain(payload.text);
  });

  it("retains partial output and successful artifacts after evaluator and artifact failures", async () => {
    const session = fixture(1);
    session.readBinaryFile.mockRejectedValueOnce(new Error("screenshot missing"));
    const result = await runSandboxRuntimeComparison({
      abortSignal: new AbortController().signal,
      artifactPaths: ["missing.png", "present.png"],
      payload: {},
      script: "// evaluator",
      session: session as never,
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
      readBinaryFile: vi.fn(async ({ path }: { path: string }) => artifacts.get(path) ?? null),
      readTextFile: vi.fn(async ({ path }: { path: string }) => files.get(path) ?? null),
      run: vi.fn(async ({ command }: { command: string }) => {
        invocation += 1;
        if (invocation === 2) {throw new Error("second probe failed before writing");}
        const outputPath = command.split(" ").at(-1);
        if (!outputPath) {throw new Error("Comparison output path is missing.");}
        files.set(outputPath, JSON.stringify({ probe: invocation }));
        artifacts.set(outputPath.replace("output.json", "capture.png"), new Uint8Array([1]));
        return { exitCode: 0, stderr: "", stdout: "" };
      }),
      writeTextFile: vi.fn(async ({ path, content }: { path: string; content: string }) => {
        files.set(path, content);
      }),
    };
    const input = {
      abortSignal: new AbortController().signal,
      artifactPaths: ["capture.png"],
      payload: {},
      script: "// evaluator",
      session: session as never,
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
        abortSignal: new AbortController().signal,
        artifactPaths: ["../credential"],
        payload: {},
        script: "",
        session: session as never,
      }),
    ).rejects.toThrow("relative child path");
    expect(session.run).not.toHaveBeenCalled();
  });
});
