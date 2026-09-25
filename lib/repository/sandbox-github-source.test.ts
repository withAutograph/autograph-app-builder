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
    const run = vi.fn().mockResolvedValue({
      exitCode: 0,
      stderr: "",
      stdout: `${sha}\n${tree}\n${expected.repository}\n`,
    });
    await expect(
      readSandboxGitHubSourceSnapshot({ run } as never, expected),
    ).resolves.toMatchObject({
      sourcePath: "/workspace/repository",
      sourceSha: sha,
      sourceTree: tree,
    });
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]?.[0].command).not.toContain("git clone");
  });

  it("rejects an occupied checkout from a different repository", async () => {
    const run = vi.fn().mockResolvedValue({
      exitCode: 0,
      stderr: "",
      stdout: `${sha}\n${tree}\nhttps://github.com/acme/other.git\n`,
    });
    await expect(readSandboxGitHubSourceSnapshot({ run } as never, expected)).rejects.toThrow(
      "does not match the selected GitHub source",
    );
  });

  it("rejects a checkout at a different revision", async () => {
    const run = vi.fn().mockResolvedValue({
      exitCode: 0,
      stderr: "",
      stdout: `${"c".repeat(40)}\n${tree}\n${expected.repository}\n`,
    });
    await expect(readSandboxGitHubSourceSnapshot({ run } as never, expected)).rejects.toThrow(
      "does not match the selected GitHub source",
    );
  });
});
