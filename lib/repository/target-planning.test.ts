import { describe, expect, it, vi } from "vitest";

import type { SandboxSession } from "eve/sandbox";

import {
  executeTargetIdentityAndPlanning,
  fixtureTargetCommandExecutor,
  sandboxTargetCommandExecutor,
  targetExecutionBinding,
  type TargetCommandExecutor,
} from "./target-planning";

function sandboxFixture() {
  const files = new Map<string, string | Uint8Array>([
    [
      ".app-builder/source-files.json",
      JSON.stringify([{ path: "apps/shell/microfrontends.json" }]),
    ],
    ["repository/apps/shell/microfrontends.json", "{}\n"],
  ]);
  const run = vi.fn(async (input: unknown) => {
    void input;
    return { exitCode: 0, stdout: "", stderr: "" };
  });
  const sandbox = {
    id: "fixture-sandbox",
    resolvePath: (path: string) => `/workspace/${path}`,
    readTextFile: async ({ path }: { path: string }) => {
      const value = files.get(path);
      return typeof value === "string" ? value : null;
    },
    readBinaryFile: async ({ path }: { path: string }) => {
      const value = files.get(path);
      return value === undefined
        ? null
        : typeof value === "string"
          ? new TextEncoder().encode(value)
          : value;
    },
    writeTextFile: async ({
      path,
      content,
    }: {
      path: string;
      content: string;
    }) => {
      files.set(path, content);
    },
    writeBinaryFile: async ({
      path,
      content,
    }: {
      path: string;
      content: Uint8Array;
    }) => {
      files.set(path, content);
    },
    run,
  } as unknown as SandboxSession;
  return { files, run, sandbox };
}

describe("typed target identity and planning", () => {
  it("materializes only builder-owned inputs and parses target-produced receipts", async () => {
    const { files, sandbox } = sandboxFixture();
    const calls: string[] = [];
    const fixture = fixtureTargetCommandExecutor();
    const executor: TargetCommandExecutor = async (input) => {
      calls.push(input.command);
      return fixture(input);
    };
    const result = await executeTargetIdentityAndPlanning({
      sandbox,
      executor,
      appId: "expense-review",
      appSpecContent: "accepted",
      appSpecDigest: "a".repeat(64),
      artifactRevision: "b".repeat(64),
    });
    expect(calls).toEqual(["identity", "planning"]);
    expect(result.identity.packageName).toBe("@autograph/expense-review");
    expect(result.proposal.contract.appSpec.sha256).toBe("a".repeat(64));
    expect(
      files.has(
        `.app-builder/target-inputs/${"b".repeat(64)}/app-contract.json`,
      ),
    ).toBe(true);
    expect(files.has("repository/prototype/expense-review/app-spec.md")).toBe(
      false,
    );
  });

  it("rejects malformed target output and unavailable real prerequisites", async () => {
    const { sandbox } = sandboxFixture();
    await expect(
      executeTargetIdentityAndPlanning({
        sandbox,
        executor: async () => ({
          exitCode: 0,
          stdout: '{"appId":"expense-review","extra":true}',
          stderr: "",
        }),
        appId: "expense-review",
        appSpecContent: "accepted",
        appSpecDigest: "a".repeat(64),
        artifactRevision: "b".repeat(64),
      }),
    ).rejects.toThrow("invalid shape");
    expect(() => targetExecutionBinding({})).toThrow(
      "offline dependency cache",
    );
  });

  it("uses only fixed commands, cwd, and an abort signal", async () => {
    const { run, sandbox } = sandboxFixture();
    const executor = sandboxTargetCommandExecutor(sandbox);
    await executor({
      command: "identity",
      appId: "expense-review",
      planningRoot: "/workspace/.app-builder/target-inputs/revision/repository",
      contractPath:
        "/workspace/.app-builder/target-inputs/revision/contract.json",
      appSpecDigest: "a".repeat(64),
    });
    expect(run).toHaveBeenCalledWith({
      command:
        "mise run repository:exec -- app-identity.ts --app expense-review",
      workingDirectory: "/workspace/repository",
      abortSignal: expect.any(AbortSignal),
    });
    expect(run.mock.calls[0]?.[0]).not.toHaveProperty("env");
  });
});
