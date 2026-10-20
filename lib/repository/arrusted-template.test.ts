import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { PreparedSandboxWorkspace } from "./supported-template";
import { samePreparedWorkspaceSourceContext } from "./supported-template";

import {
  acquireCanonicalArrustedTemplate,
  inspectCanonicalArrustedSandboxWorkspace,
  inspectSourceBoundSandboxWorkspace,
} from "./arrusted-template";
import {
  inspectCanonicalTemplateSnapshotReceipt,
  inspectExistingRepositorySnapshotReceipt,
} from "./source-receipt";

describe("canonical Arrusted source preparation", () => {
  it("uses the provider-created starter checkout once", async () => {
    const sourceSha = "a".repeat(40);
    const sourceTree = "b".repeat(40);
    const commands: string[] = [];
    const written: string[] = [];
    const run = vi.fn(async ({ command }: { command: string }) => {
      await Promise.resolve();
      commands.push(command);
      return {
        exitCode: command.startsWith("test -L ") ? 1 : 0,
        stderr: "",
        stdout: command.includes("rev-parse")
          ? `${sourceSha}\n${sourceTree}\nhttps://github.com/withAutograph/arrusted-development.git\n`
          : "",
      };
    });
    const receipt = await acquireCanonicalArrustedTemplate({
      callId: "prepare",
      reader: { acquire: async () => await Promise.resolve({ token: "test-token" }) },
      sandbox: {
        id: "sandbox",
        readTextFile: async () => await Promise.resolve(null),
        run,
        writeTextFile: async ({ path }: { path: string }) => {
          await Promise.resolve();
          written.push(path);
        },
      } as never,
    });
    expect(receipt.sourceKind).toBe("fresh-template");
    expect(commands.some((command) => command.includes("git clone"))).toBe(false);
    expect(written).toContain(".app-builder/prepare-intent.json");
  });

  it("reuses the recorded session workspace without legacy reinspection", async () => {
    const receipt = inspectCanonicalTemplateSnapshotReceipt({
      readinessDigest: "c".repeat(64),
      snapshot: {
        contents: {},
        contract: [],
        dirtyPaths: [],
        sourcePath: "/workspace/repository",
        sourceSha: "a".repeat(40),
        sourceTree: "b".repeat(40),
      },
    });
    if (receipt.version !== 4) {
      throw new Error("Expected cloned source fixture");
    }
    const workspace = {
      adapter: "arrusted-development-v0",
      eligibilityDigest: receipt.eligibilityDigest,
      sourcePath: "/workspace/repository",
      sourceSha: receipt.sourceSha,
      sourceTree: receipt.sourceTree,
      workspaceDigest: "d".repeat(64),
      workspaceId: "sandbox",
      workspacePath: "/workspace/repository",
    } as const;
    const run = vi.fn();

    await expect(
      inspectCanonicalArrustedSandboxWorkspace({
        receipt,
        sandbox: {
          id: "sandbox",
          // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
          readTextFile: vi.fn(async () => JSON.stringify(workspace)),
          run,
        } as never,
      }),
    ).resolves.toEqual(workspace);
    expect(run).not.toHaveBeenCalled();
  });
});

describe("connected GitHub workspace inspection", () => {
  const repository = "https://github.com/acme/private.git";
  const originalSha = "a".repeat(40);
  const originalTree = "b".repeat(40);
  const receipt = inspectExistingRepositorySnapshotReceipt({
    contents: {},
    contract: [],
    dirtyPaths: [],
    sourcePath: "/workspace/repository",
    sourceSha: originalSha,
    sourceTree: originalTree,
  });
  const originalWorkspace = {
    adapter: "arrusted-development-v0",
    eligibilityDigest: receipt.eligibilityDigest,
    sourcePath: receipt.sourcePath,
    sourceSha: receipt.sourceSha,
    sourceTree: receipt.sourceTree,
    workspaceDigest: "c".repeat(64),
    workspaceId: "sandbox",
    workspacePath: "/workspace/repository",
  } as const;

  it.each([
    ["the selected revision", originalSha, originalTree],
    ["a newer revision", "d".repeat(40), "e".repeat(40)],
  ])(
    "uses the live checkout at %s despite an older diagnostic record",
    async (_name, sha, tree) => {
      const run = vi
        .fn()
        .mockResolvedValueOnce({
          exitCode: 0,
          stderr: "",
          stdout: `${sha}\n${tree}\n${repository}\n`,
        })
        .mockResolvedValueOnce({ exitCode: 1, stderr: "", stdout: "" });
      const observed = await inspectSourceBoundSandboxWorkspace({
        expectedWorkspace: originalWorkspace,
        githubSource: { repository: { name: "private", owner: "acme" } } as never,
        receipt,
        sandbox: { id: "sandbox", run } as never,
      });
      expect(observed).toMatchObject({
        sourceSha: sha,
        sourceTree: tree,
        workspaceId: "sandbox",
      });
    },
  );

  it("rejects a checkout belonging to another repository", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({
        exitCode: 0,
        stderr: "",
        stdout: `${originalSha}\n${originalTree}\nhttps://github.com/acme/other.git\n`,
      })
      .mockResolvedValueOnce({ exitCode: 1, stderr: "", stdout: "" });
    await expect(
      inspectSourceBoundSandboxWorkspace({
        expectedWorkspace: originalWorkspace,
        githubSource: { repository: { name: "private", owner: "acme" } } as never,
        receipt,
        sandbox: { id: "sandbox", run } as never,
      }),
    ).rejects.toThrow("does not match the selected GitHub source");
  });
});

const legacySourceFixture = () => {
  const receipt = inspectExistingRepositorySnapshotReceipt({
    contents: {},
    contract: [],
    dirtyPaths: [],
    sourcePath: "/selected/source",
    sourceSha: "a".repeat(40),
    sourceTree: "b".repeat(40),
  });
  const digest = (value: string) => createHash("sha256").update(value).digest("hex");
  const manifest = [
    { mode: "100644", objectId: "c".repeat(40), path: "app.txt", sha256: digest("original app") },
  ];
  const observed: PreparedSandboxWorkspace = {
    adapter: "arrusted-development-v0",
    eligibilityDigest: "d".repeat(64),
    sourcePath: receipt.sourcePath,
    sourceSha: receipt.sourceSha,
    sourceTree: receipt.sourceTree,
    workspaceId: "sandbox",
    workspacePath: "/workspace/repository",
    workspaceDigest: digest(JSON.stringify(manifest)),
  };
  const files = new Map([
    [".app-builder/prepared-workspace.json", JSON.stringify(observed)],
    [".app-builder/source-files.json", JSON.stringify(manifest)],
    [".app-builder/source-checksums.sha256", `${manifest[0]?.sha256}  repository/app.txt\n`],
    ["repository/app.txt", "edited app"],
    ["repository/new.txt", "new file"],
  ]);
  const sandbox = {
    id: "sandbox",
    readTextFile: vi.fn(
      async ({ path }: { path: string }) => await Promise.resolve(files.get(path) ?? null),
    ),
    readBinaryFile: vi.fn(),
    run: vi.fn(
      async () =>
        await Promise.resolve({
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify({
            repositoryInput: "/workspace/repository",
            realRepository: "/workspace/repository",
            realWorkspace: "/workspace",
            workspaceRoot: "/workspace",
          }),
        }),
    ),
  };
  return { files, observed, receipt, sandbox };
};

describe("legacy source-bound writable workspace", () => {
  it("accepts edits and diagnostic metadata changes without treating the base manifest as current content", async () => {
    const { observed, receipt, sandbox } = legacySourceFixture();
    const expectedWorkspace = { ...observed, eligibilityDigest: "e".repeat(64) };
    expect(samePreparedWorkspaceSourceContext(observed, expectedWorkspace)).toBe(true);
    await expect(
      inspectSourceBoundSandboxWorkspace({ receipt, expectedWorkspace, sandbox: sandbox as never }),
    ).resolves.toEqual(observed);
    expect(sandbox.readBinaryFile).not.toHaveBeenCalled();
  });

  it.each(["sourcePath", "sourceSha", "sourceTree", "workspaceId", "workspaceDigest"] as const)(
    "rejects a different retained %s",
    async (field) => {
      const { observed, receipt, sandbox } = legacySourceFixture();
      const changedValue = field === "workspaceDigest" ? "f".repeat(64) : "f".repeat(40);
      const expectedWorkspace = {
        ...observed,
        [field]: field === "sourcePath" ? "/other/source" : changedValue,
      };
      await expect(
        inspectSourceBoundSandboxWorkspace({
          receipt,
          expectedWorkspace,
          sandbox: sandbox as never,
        }),
      ).rejects.toThrow("no longer matches its durable source receipt");
    },
  );

  it("rejects a foreign Sandbox even with retained source metadata", async () => {
    const { observed, receipt, sandbox } = legacySourceFixture();
    await expect(
      inspectSourceBoundSandboxWorkspace({
        receipt,
        expectedWorkspace: observed,
        sandbox: { ...sandbox, id: "other" } as never,
      }),
    ).rejects.toThrow("does not belong to this session");
  });
});
