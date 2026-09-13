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
      path: ".self-reproduction-comparison/input.json",
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
