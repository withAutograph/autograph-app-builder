import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { SandboxSession } from "eve/sandbox";
import { sandboxApplyCommandExecutor, targetApplyCommandReceiptSchema } from "./target-apply";
import { targetIterationProposalSchema } from "./target-planning";

const digest = (content: string) => createHash("sha256").update(content).digest("hex");
const before = '{"dependencies":{}}';
const after = '{"dependencies":{"path-to-regexp":"8.4.2"}}';
const fixture = (options: { stale?: boolean; installFails?: boolean; cueFails?: boolean } = {}) => {
  const events: string[] = [];
  const policies: Parameters<SandboxSession["setNetworkPolicy"]>[0][] = [];
  let manifest = options.stale === true ? "changed by another writer" : before;
  const failure = { exitCode: 1, stderr: "package not found", stdout: "" };
  const cueFailure = { exitCode: 1, stderr: "cue source activation failed", stdout: "cue output" };
  const sandbox = {
    id: "fixture",
    readBinaryFile: vi.fn<SandboxSession["readBinaryFile"]>(async ({ path }) => {
      await Promise.resolve();
      events.push(`read:${path}`);
      return Buffer.from(manifest);
    }),
    readFile: vi.fn<SandboxSession["readFile"]>(async () => {
      await Promise.resolve();
      throw new Error("The dependency installation fixture does not read streams.");
    }),
    readTextFile: vi.fn<SandboxSession["readTextFile"]>(async () => {
      await Promise.resolve();
      throw new Error("The dependency installation fixture does not read text files.");
    }),
    removePath: vi.fn<SandboxSession["removePath"]>(async () => {
      await Promise.resolve();
    }),
    resolvePath: (path) => path,
    run: vi.fn<SandboxSession["run"]>(async ({ command }) => {
      await Promise.resolve();
      if (command === "bun install") {
        events.push("install");
        expect(manifest).toBe(after);
        return options.installFails === true ? failure : { exitCode: 0, stderr: "", stdout: "" };
      }
      expect(command).toContain('cue_bin="$(mise which cue)"');
      expect(command).toContain('ln -sfn "$cue_bin" "$toolchain_bin/cue"');
      events.push("cue");
      return options.cueFails === true ? cueFailure : { exitCode: 0, stderr: "", stdout: "" };
    }),
    setNetworkPolicy: vi.fn<SandboxSession["setNetworkPolicy"]>(async (policy) => {
      await Promise.resolve();
      policies.push(policy);
    }),
    spawn: vi.fn<SandboxSession["spawn"]>(async () => {
      await Promise.resolve();
      throw new Error("The dependency installation fixture does not spawn processes.");
    }),
    writeBinaryFile: vi.fn<SandboxSession["writeBinaryFile"]>(async () => {
      await Promise.resolve();
      throw new Error("The dependency installation fixture does not write binary files.");
    }),
    writeFile: vi.fn<SandboxSession["writeFile"]>(async () => {
      await Promise.resolve();
      throw new Error("The dependency installation fixture does not write streams.");
    }),
    writeTextFile: vi.fn<SandboxSession["writeTextFile"]>(async ({ content }) => {
      await Promise.resolve();
      events.push("write");
      manifest = content;
    }),
  } satisfies SandboxSession;
  const changes = [
    {
      after: { content: after, digest: digest(after), mode: "644" },
      before: { digest: digest(before), mode: "644" },
      path: "apps/vendor/package.json",
    },
  ];
  const proposal = targetIterationProposalSchema.parse({
    blockers: [],
    contract: {
      appId: "vendor",
      appSpec: { path: "apps/vendor/app-spec.md", sha256: digest("app spec") },
      version: 1,
    },
    futurePath: "apps/vendor/app.contract.json",
    iteration: {
      changes,
      digest: digest(JSON.stringify(changes)),
    },
    mutations: [],
    operation: "iterate-existing-app",
    plan: {
      product: {
        appSpec: { path: "apps/vendor/app-spec.md", sha256: digest("app spec") },
        optionalCapabilities: { hostedResources: [], integrations: [] },
        owner: "App Builder",
      },
      source: {
        packageName: "@autograph/vendor",
        runtime: "nextjs",
        schema: { kind: "none" },
        workspacePath: "apps/vendor",
      },
      topology: {
        configPath: "microfrontends.json",
        packageName: "@autograph/vendor",
        projectName: "apps-vendor",
        routes: ["/vendor"],
      },
    },
  });
  const execute = async () =>
    await sandboxApplyCommandExecutor()({
      appId: "vendor",
      applyRoot: "/workspace/repository",
      proposal,
      proposalPath: "/workspace/proposal.json",
      sandbox,
    });
  return { cueFailure, events, execute, failure, policies, sandbox };
};

describe("existing-app dependency installation", () => {
  it("installs the resulting manifest in the applied checkout before reporting success", async () => {
    const state = fixture();
    const result = await state.execute();
    expect(result.exitCode).toBe(0);
    const receipt = targetApplyCommandReceiptSchema.parse(JSON.parse(result.stdout));
    expect(receipt.appId).toBe("vendor");
    expect(state.events).toEqual([
      "read:repository/apps/vendor/package.json",
      "write",
      "install",
      "cue",
    ]);
    expect(state.policies).toEqual(["allow-all"]);
    expect(state.sandbox.run).toHaveBeenNthCalledWith(1, {
      command: "bun install",
      workingDirectory: "/workspace/repository",
    });
    expect(state.sandbox.run).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ workingDirectory: "/workspace/repository" }),
    );
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
  it("returns CUE activation failure after writes without an applied receipt or generator dispatch", async () => {
    const state = fixture({ cueFails: true });
    expect(await state.execute()).toEqual(state.cueFailure);
    expect(state.sandbox.writeTextFile).toHaveBeenCalledOnce();
    expect(state.events).toEqual([
      "read:repository/apps/vendor/package.json",
      "write",
      "install",
      "cue",
    ]);
    expect(state.sandbox.run).toHaveBeenCalledTimes(2);
  });
});
