import { describe, expect, it, vi } from "vitest";

import { readSandboxGitHubSourceSnapshot } from "./sandbox-github-source";

const sha = "a".repeat(40);
const tree = "b".repeat(40);
const expected = {
  repository: "https://github.com/acme/private.git",
  sourceSha: sha,
  sourceTree: tree,
};

describe("provider-created sandbox GitHub source", () => {
  it("reads the selected checkout without cloning it again", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({
        exitCode: 0,
        stderr: "",
        stdout: `${sha}\n${tree}\n${expected.repository}\n`,
      })
      .mockResolvedValueOnce({ exitCode: 1, stderr: "", stdout: "" });
    await expect(
      readSandboxGitHubSourceSnapshot({ run } as never, expected),
    ).resolves.toMatchObject({
      sourcePath: "/workspace/repository",
      sourceSha: sha,
      sourceTree: tree,
    });
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[0]?.[0].command).not.toContain("git clone");
  });

  it("moves a verified provider-created checkout into the Builder workspace", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 128, stderr: "", stdout: "" })
      .mockResolvedValueOnce({ exitCode: 1, stderr: "", stdout: "" })
      .mockResolvedValueOnce({
        exitCode: 0,
        stderr: "",
        stdout: `${sha}\n${tree}\n${expected.repository}\n`,
      })
      .mockResolvedValueOnce({ exitCode: 0, stderr: "", stdout: "" })
      .mockResolvedValueOnce({
        exitCode: 0,
        stderr: "",
        stdout: `${sha}\n${tree}\n${expected.repository}\n`,
      });
    await expect(
      readSandboxGitHubSourceSnapshot({ run } as never, expected),
    ).resolves.toMatchObject({ sourcePath: "/workspace/repository", sourceSha: sha });
    expect(run.mock.calls[2]?.[0].command).toContain("git -C '/workspace/private' rev-parse HEAD");
    expect(run.mock.calls[3]?.[0].command).toContain("renameSync");
    for (const call of run.mock.calls) {
      expect(call[0].command).not.toContain("git clone");
    }
  });

  it("uses the standard Vercel working directory when the Eve image path is absent", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 128, stderr: "", stdout: "" })
      .mockResolvedValueOnce({ exitCode: 1, stderr: "", stdout: "" })
      .mockResolvedValueOnce({ exitCode: 128, stderr: "", stdout: "" })
      .mockResolvedValueOnce({
        exitCode: 0,
        stderr: "",
        stdout: `${sha}\n${tree}\n${expected.repository}\n`,
      })
      .mockResolvedValueOnce({ exitCode: 0, stderr: "", stdout: "" })
      .mockResolvedValueOnce({
        exitCode: 0,
        stderr: "",
        stdout: `${sha}\n${tree}\n${expected.repository}\n`,
      });
    await expect(
      readSandboxGitHubSourceSnapshot({ run } as never, expected),
    ).resolves.toMatchObject({ sourcePath: "/workspace/repository", sourceSha: sha });
    expect(run.mock.calls[3]?.[0].command).toContain("git -C '/vercel/sandbox' rev-parse HEAD");
    expect(run.mock.calls[4]?.[0].command).toContain("renameSync");
  });

  it("does not alter an occupied workspace that is not a Git checkout", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 128, stderr: "", stdout: "" })
      .mockResolvedValueOnce({ exitCode: 0, stderr: "", stdout: "" });
    await expect(readSandboxGitHubSourceSnapshot({ run } as never, expected)).rejects.toThrow(
      "checkout is not available",
    );
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("reports when Vercel did not create the selected Git checkout", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 128, stderr: "", stdout: "" })
      .mockResolvedValueOnce({ exitCode: 1, stderr: "", stdout: "" })
      .mockResolvedValueOnce({ exitCode: 128, stderr: "", stdout: "" })
      .mockResolvedValueOnce({ exitCode: 128, stderr: "", stdout: "" });
    await expect(readSandboxGitHubSourceSnapshot({ run } as never, expected)).rejects.toThrow(
      "Vercel did not materialize the selected GitHub source",
    );
    expect(run).toHaveBeenCalledTimes(4);
  });

  it("rejects a mismatched provider checkout before linking it", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 128, stderr: "", stdout: "" })
      .mockResolvedValueOnce({ exitCode: 1, stderr: "", stdout: "" })
      .mockResolvedValueOnce({
        exitCode: 0,
        stderr: "",
        stdout: `${sha}\n${tree}\nhttps://github.com/acme/other.git\n`,
      });
    await expect(readSandboxGitHubSourceSnapshot({ run } as never, expected)).rejects.toThrow(
      "does not match the selected GitHub source",
    );
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("rejects an occupied checkout from a different repository", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({
        exitCode: 0,
        stderr: "",
        stdout: `${sha}\n${tree}\nhttps://github.com/acme/other.git\n`,
      })
      .mockResolvedValueOnce({ exitCode: 1, stderr: "", stdout: "" });
    await expect(readSandboxGitHubSourceSnapshot({ run } as never, expected)).rejects.toThrow(
      "does not match the selected GitHub source",
    );
  });

  it("rejects a checkout at a different revision", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({
        exitCode: 0,
        stderr: "",
        stdout: `${"c".repeat(40)}\n${tree}\n${expected.repository}\n`,
      })
      .mockResolvedValueOnce({ exitCode: 1, stderr: "", stdout: "" });
    await expect(readSandboxGitHubSourceSnapshot({ run } as never, expected)).rejects.toThrow(
      "does not match the selected GitHub source",
    );
  });

  it("does not change a linked checkout left by an older Builder session", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({
        exitCode: 0,
        stderr: "",
        stdout: `${sha}\n${tree}\n${expected.repository}\n`,
      })
      .mockResolvedValueOnce({ exitCode: 0, stderr: "", stdout: "" });
    await expect(readSandboxGitHubSourceSnapshot({ run } as never, expected)).rejects.toThrow(
      "Start a new Builder session",
    );
    expect(run).toHaveBeenCalledTimes(2);
  });
});
