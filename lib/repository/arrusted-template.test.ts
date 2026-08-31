import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { SandboxSession } from "eve/sandbox";

import {
  prepareCanonicalArrustedSandboxWorkspace,
  templateReadinessAttestationDigest,
} from "./arrusted-template";
import type { SourceReceipt } from "./source-receipt";

describe("canonical Arrusted template readiness", () => {
  it("clones the admitted source directly into the session workspace before restoring deny-all networking", async () => {
    const sourceSha = "a".repeat(40);
    const sourceTree = "b".repeat(40);
    const sourceBytes = Buffer.from("{}\n");
    const sourceFiles = [
      {
        mode: "100644",
        objectId: "c".repeat(40),
        path: "microfrontends.json",
        sha256: createHash("sha256").update(sourceBytes).digest("hex"),
      },
    ];
    const workspaceDigest = createHash("sha256")
      .update(JSON.stringify(sourceFiles))
      .digest("hex");
    const files = new Map<string, string>([
      [
        ".app-builder/source-files.json",
        `${JSON.stringify(sourceFiles, null, 2)}\n`,
      ],
      [
        ".app-builder/source-checksums.sha256",
        `${sourceFiles[0]!.sha256}  repository/microfrontends.json\n`,
      ],
    ]);
    const setNetworkPolicy = vi.fn(async () => undefined);
    const run = vi
      .fn()
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify({ sourceTree, workspaceDigest }),
        stderr: "",
      })
      .mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    const sandbox = {
      id: "sandbox-template-clone",
      readTextFile: vi.fn(
        async ({ path }: { path: string }) => files.get(path) ?? null,
      ),
      readBinaryFile: vi.fn(async ({ path }: { path: string }) =>
        path === "repository/microfrontends.json" ? sourceBytes : null,
      ),
      writeTextFile: vi.fn(
        async ({ path, content }: { path: string; content: string }) => {
          files.set(path, content);
        },
      ),
      setNetworkPolicy,
      run,
    } as unknown as SandboxSession;
    const receipt = {
      version: 4,
      sourceKind: "fresh-template",
      sourcePath: "/tmp/arrusted-source",
      sourceSha,
      sourceTree,
      adapter: "arrusted-development-v0",
      eligibilityDigest: "d".repeat(64),
      contractDigest: "e".repeat(64),
      releaseEnabled: false,
      provenance: {
        repository: "https://github.com/withAutograph/arrusted-development.git",
        ref: "refs/heads/main",
        method: "git-clone-v1",
        readinessDigest: "f".repeat(64),
      },
      digest: "0".repeat(64),
    } as Extract<SourceReceipt, { version: 4 }>;

    const workspace = await prepareCanonicalArrustedSandboxWorkspace({
      sandbox,
      receipt,
      callId: "call-template-clone",
    });

    expect(workspace).toMatchObject({
      workspacePath: "/workspace/repository",
      sourcePath: "/workspace/repository",
      sourceSha,
      sourceTree,
    });
    expect(run.mock.calls[0]?.[0].command).toContain(
      "clone --no-checkout --no-recurse-submodules --single-branch --branch main",
    );
    expect(run.mock.calls[0]?.[0].command).toContain("checkout --detach");
    expect(run.mock.calls[0]?.[0].command).toContain(
      "core.hooksPath=/dev/null",
    );
    expect(setNetworkPolicy).toHaveBeenNthCalledWith(1, {
      allow: ["github.com"],
    });
    expect(setNetworkPolicy).toHaveBeenLastCalledWith("deny-all");
  });

  it("binds a successful exact-SHA Template readiness check into the source receipt digest", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({
        check_runs: [
          {
            id: 123,
            name: "Template readiness",
            status: "completed",
            conclusion: "success",
            started_at: "2026-08-31T16:00:00Z",
            completed_at: "2026-08-31T16:01:00Z",
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetch);

    const digest = await templateReadinessAttestationDigest(
      "a".repeat(40),
      "b".repeat(40),
    );

    expect(digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(fetch).toHaveBeenCalledWith(
      "https://api.github.com/repos/withAutograph/arrusted-development/commits/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/check-runs?per_page=100",
      expect.objectContaining({ redirect: "error" }),
    );
    vi.unstubAllGlobals();
  });

  it("fails closed when the exact SHA has no successful readiness check", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof globalThis.fetch>(async () =>
        Response.json({
          check_runs: [
            {
              id: 123,
              name: "Template readiness",
              status: "completed",
              conclusion: "failure",
              started_at: "2026-08-31T16:00:00Z",
              completed_at: "2026-08-31T16:01:00Z",
            },
          ],
        }),
      ),
    );

    await expect(
      templateReadinessAttestationDigest("a".repeat(40), "b".repeat(40)),
    ).rejects.toThrow("no successful template-readiness evidence");
    vi.unstubAllGlobals();
  });
});
