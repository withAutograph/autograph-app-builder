import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { SandboxSession } from "eve/sandbox";
import { sandboxApplyCommandExecutor } from "./target-apply";
import type { TargetProposal } from "./target-planning";

const digest = (content: string) => createHash("sha256").update(content).digest("hex");
const before = '{"dependencies":{}}';
const after = '{"dependencies":{"path-to-regexp":"8.4.2"}}';
const fixture = (options: { stale?: boolean; installFails?: boolean } = {}) => {
  const events: string[] = [];
  let manifest = options.stale ? "changed by another writer" : before;
  const failure = { exitCode: 1, stderr: "package not found", stdout: "" };
  const sandbox = {
    readBinaryFile: vi.fn(({ path }: { path: string }) => {
      events.push(`read:${path}`);
      return Promise.resolve(Buffer.from(manifest));
    }),
    run: vi.fn(() => {
      events.push("install");
      expect(manifest).toBe(after);
      return Promise.resolve(
        options.installFails ? failure : { exitCode: 0, stderr: "", stdout: "" },
      );
    }),
    setNetworkPolicy: vi.fn((policy: string) => {
      events.push(policy);
      return Promise.resolve();
    }),
    writeTextFile: vi.fn(({ content }: { content: string }) => {
      events.push("write");
      manifest = content;
      return Promise.resolve();
    }),
  };
  const proposal = {
    contract: { appId: "vendor" },
    futurePath: "apps/vendor/app.contract.json",
    iteration: {
      changes: [
        {
          after: { content: after, digest: digest(after) },
          before: { digest: digest(before) },
          path: "apps/vendor/package.json",
        },
      ],
    },
    operation: "iterate-existing-app",
    plan: { source: { workspacePath: "apps/vendor" }, topology: {} },
  } as unknown as TargetProposal;
  const execute = () =>
    sandboxApplyCommandExecutor()({
      appId: "vendor",
      applyRoot: "/workspace/repository",
      proposal,
      proposalPath: "/workspace/proposal.json",
      sandbox: sandbox as unknown as SandboxSession,
    });
  return { events, execute, failure, sandbox };
};

describe("existing-app dependency installation", () => {
  it("installs the resulting manifest in the applied checkout before reporting success", async () => {
    const state = fixture();
    const result = await state.execute();
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).appId).toBe("vendor");
    expect(state.events).toEqual([
      "read:repository/apps/vendor/package.json",
      "write",
      "allow-all",
      "install",
    ]);
    expect(state.sandbox.run).toHaveBeenCalledExactlyOnceWith({
      command: "bun install",
      workingDirectory: "/workspace/repository",
    });
  });
  it("rejects stale preimages before any writes or installation", async () => {
    const state = fixture({ stale: true });
    const result = await state.execute();
    expect(result.exitCode).toBe(2);
    expect(state.sandbox.writeTextFile).not.toHaveBeenCalled();
    expect(state.sandbox.setNetworkPolicy).not.toHaveBeenCalled();
    expect(state.sandbox.run).not.toHaveBeenCalled();
  });
  it("returns the real installation failure after writes instead of an applied receipt", async () => {
    const state = fixture({ installFails: true });
    expect(await state.execute()).toEqual(state.failure);
    expect(state.sandbox.writeTextFile).toHaveBeenCalledOnce();
    expect(state.sandbox.run).toHaveBeenCalledOnce();
  });
});
