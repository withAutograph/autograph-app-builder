import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { SandboxSession } from "eve/sandbox";

import {
  createGitHubInstallationIdentity,
  createRepositoryObservation,
  resolveImmutableExistingSource,
} from "./github-publication";
import {
  cloneGitHubSourceWorkspace,
  inspectGitHubSourceSandboxWorkspace,
} from "./sandbox-github-source";
import { inspectExistingRepositorySnapshotReceipt } from "./source-receipt";
import { SUPPORTED_TEMPLATE_INPUT_PATHS } from "./supported-template";

const sha256 = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const sourceSha = "1".repeat(40);
const sourceTree = "2".repeat(40);

function eligibleContents() {
  return {
    ".config/mise/config.toml": [
      '[tasks."create:app"]',
      '[tasks."repository:preflight"]',
      '[tasks."app:check-build"]',
      'app-validation.ts check-build "$usage_app"',
      '[tasks."app:test"]',
      'app-validation.ts test "$usage_app" "$usage_shard"',
      '[tasks."generate:app"]',
      "turbo gen --config .config/turbo/generators/config.ts app --args",
    ].join("\n"),
    ".github/workflows/cd.yml": [
      "jobs:",
      "  template-safety:",
      "    name: Authorize (Template instance safety)",
      "    permissions: {}",
      "    outputs:",
      "      enabled: ${{ steps.safety.outputs.enabled }}",
      "    steps:",
      "      - id: safety",
      "        name: Read active repository safety flag",
      "        env:",
      "          REPOSITORY_RELEASE_ENABLED: ${{ vars.REPOSITORY_RELEASE_ENABLED }}",
      "        run: |",
      "          set -euo pipefail",
      '          value="$REPOSITORY_RELEASE_ENABLED"',
      "          enabled=false",
      '          if [[ "$value" == "true" ]]; then',
      "            enabled=true",
      "          fi",
      '          echo "enabled=$enabled" >> "$GITHUB_OUTPUT"',
      "  scope:",
      "    needs: template-safety",
      "    if: needs.template-safety.outputs.enabled == 'true' && github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.event == 'push' && github.event.workflow_run.head_branch == github.event.repository.default_branch && github.event.workflow_run.head_repository.full_name == github.repository",
    ].join("\n"),
    "microfrontends.json": "{}\n",
    ".config/mise/scripts/repository/app-contract.ts":
      'const source = { runtime: "nextjs" };\n',
    ".config/mise/scripts/repository/app-identity.ts": "export {};\n",
    ".config/mise/scripts/repository/app-validation.ts": "export {};\n",
    ".config/mise/scripts/repository/repository-preflight.ts": [
      'runtime: "nextjs"',
      "mise run repository:exec -- app-identity.ts --app <app-id>",
      "mise run repository:exec -- app-contract.ts --contract <contract-file>",
      "mise run create:app -- --proposal <proposal-file>",
      "mise run repository:preflight",
      "mise run app:check-build <app-id>",
      "mise run app:test <app-id> <shard>",
    ].join("\n"),
    ".config/turbo/generators/config.ts": 'const scope = "autograph";\n',
    ".config/turbo/generators/create-app.ts": "export {};\n",
    ".config/turbo/generators/templates/app/next.config.ts.hbs":
      "export default {};\n",
  };
}

function sourceFixture() {
  const contents = eligibleContents();
  const sourceBytes = Buffer.from("{}\n");
  const sourceFiles = [
    {
      mode: "100644" as const,
      objectId: "3".repeat(40),
      path: "microfrontends.json",
      sha256: sha256(sourceBytes),
    },
  ];
  const workspaceDigest = sha256(JSON.stringify(sourceFiles));
  const snapshot = {
    sourcePath: "/workspace/repository",
    sourceSha,
    sourceTree,
    dirtyPaths: [] as string[],
    contents,
    contract: SUPPORTED_TEMPLATE_INPUT_PATHS.map((path) => ({
      path,
      mode: "100644",
      objectId: "4".repeat(40),
      sha256: sha256(contents[path]),
    })),
  };
  return { contents, snapshot, sourceBytes, sourceFiles, workspaceDigest };
}

async function githubSource() {
  const installation = createGitHubInstallationIdentity({
    operation: "resolve-existing-source",
    installationId: "10",
    accountId: "11",
    accountLogin: "withAutograph",
    accountType: "Organization",
    repositorySelection: "selected",
    selectedRepositoryIds: ["200"],
  });
  const repository = createRepositoryObservation({
    repositoryId: "200",
    owner: "withAutograph",
    name: "app-builder-dogfood",
    visibility: "private",
    defaultBranch: "main",
    headSha: sourceSha,
    headTree: sourceTree,
    installationIdentityDigest: installation.digest,
    releaseGate: {
      name: "REPOSITORY_RELEASE_ENABLED",
      configured: true,
    },
  });
  return await resolveImmutableExistingSource({
    adapter: {
      inspectInstallation: vi.fn(async () => installation),
      inspectRepository: vi.fn(async () => repository),
    },
    expectedInstallationId: "10",
    repositoryId: "200",
    ref: "refs/heads/main",
    expectedSha: sourceSha,
    expectedTree: sourceTree,
    resolvedByCallId: "call-source",
  });
}

describe("sandbox GitHub source transport", () => {
  it("rejects a hostile branch before writing credentials or opening network access", async () => {
    const sandbox = {
      readTextFile: vi.fn(),
      writeTextFile: vi.fn(),
      setNetworkPolicy: vi.fn(),
      run: vi.fn(),
    } as unknown as SandboxSession;

    await expect(
      cloneGitHubSourceWorkspace({
        sandbox,
        token: "ghs_repository_scoped_read_token",
        remote: "https://github.com/withAutograph/app-builder-dogfood.git",
        branch: "main;touch-pwned",
        expectedSha: sourceSha,
        expectedTree: sourceTree,
      }),
    ).rejects.toThrow("branch is invalid");
    expect(sandbox.writeTextFile).not.toHaveBeenCalled();
    expect(sandbox.setNetworkPolicy).not.toHaveBeenCalled();
    expect(sandbox.run).not.toHaveBeenCalled();
  });

  it("clones the exact tree, keeps credentials out of the command, and restores deny-all", async () => {
    const fixture = sourceFixture();
    const files = new Map<string, string>();
    const run = vi.fn(async ({ command }: { command: string }) => {
      files.set(
        ".app-builder/source-files.json",
        `${JSON.stringify(fixture.sourceFiles, null, 2)}\n`,
      );
      files.set(
        ".app-builder/source-checksums.sha256",
        `${fixture.sourceFiles[0]!.sha256}  repository/microfrontends.json\n`,
      );
      files.set(
        ".app-builder/canonical-clone-inspection.json",
        JSON.stringify(fixture.snapshot),
      );
      expect(command).not.toContain("ghs_repository_scoped_read_token");
      expect(command).toContain("refs/remotes/origin/main");
      expect(command).toContain('ls-tree", "-r", "-z"');
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          sourceSha,
          sourceTree,
          workspaceDigest: fixture.workspaceDigest,
        }),
        stderr: "",
      };
    });
    const setNetworkPolicy = vi.fn(async () => undefined);
    const sandbox = {
      id: "sandbox-source",
      readTextFile: vi.fn(
        async ({ path }: { path: string }) => files.get(path) ?? null,
      ),
      writeTextFile: vi.fn(
        async ({ path, content }: { path: string; content: string }) => {
          files.set(path, content);
        },
      ),
      removePath: vi.fn(async ({ path }: { path: string }) => {
        files.delete(path);
      }),
      setNetworkPolicy,
      run,
    } as unknown as SandboxSession;

    await expect(
      cloneGitHubSourceWorkspace({
        sandbox,
        token: "ghs_repository_scoped_read_token",
        remote: "https://github.com/withAutograph/app-builder-dogfood.git",
        branch: "main",
        expectedSha: sourceSha,
        expectedTree: sourceTree,
      }),
    ).resolves.toEqual({
      snapshot: fixture.snapshot,
      workspaceDigest: fixture.workspaceDigest,
    });
    expect(setNetworkPolicy.mock.calls).toEqual([
      ["deny-all"],
      [{ allow: ["github.com"] }],
      ["deny-all"],
    ]);
    expect(files.has(".app-builder/arrusted-template-reader-token")).toBe(
      false,
    );
  });

  it.each(["askpass-write", "clone-run"] as const)(
    "removes clone credentials and restores deny-all after %s failure",
    async (failure) => {
      const files = new Map<string, string>();
      const removePath = vi.fn(async ({ path }: { path: string }) => {
        files.delete(path);
      });
      const setNetworkPolicy = vi.fn(async () => undefined);
      let writes = 0;
      const sandbox = {
        id: "sandbox-source",
        readTextFile: vi.fn(async () => null),
        writeTextFile: vi.fn(
          async ({ path, content }: { path: string; content: string }) => {
            writes += 1;
            if (failure === "askpass-write" && writes === 2)
              throw new Error("write failed");
            files.set(path, content);
          },
        ),
        removePath,
        setNetworkPolicy,
        run: vi.fn(async () => {
          throw new Error("run failed");
        }),
      } as unknown as SandboxSession;

      await expect(
        cloneGitHubSourceWorkspace({
          sandbox,
          token: "ghs_repository_scoped_read_token",
          remote: "https://github.com/withAutograph/app-builder-dogfood.git",
          branch: "main",
          expectedSha: sourceSha,
          expectedTree: sourceTree,
        }),
      ).rejects.toThrow(
        failure === "askpass-write" ? "write failed" : "run failed",
      );
      expect(removePath).toHaveBeenCalledTimes(2);
      expect(setNetworkPolicy).toHaveBeenLastCalledWith("deny-all");
      expect(
        [...files.keys()].some((path) => path.includes("reader-token")),
      ).toBe(false);
    },
  );

  it("restores deny-all before rejecting a tampered prepared-workspace record", async () => {
    const setNetworkPolicy = vi.fn(async () => undefined);
    const sandbox = {
      readTextFile: vi.fn(async ({ path }: { path: string }) =>
        path === ".app-builder/prepared-workspace.json" ? "{}" : null,
      ),
      setNetworkPolicy,
    } as unknown as SandboxSession;

    await expect(
      cloneGitHubSourceWorkspace({
        sandbox,
        token: "ghs_repository_scoped_read_token",
        remote: "https://github.com/withAutograph/app-builder-dogfood.git",
        branch: "main",
        expectedSha: sourceSha,
        expectedTree: sourceTree,
      }),
    ).rejects.toThrow("prepared workspace record is invalid");
    expect(setNetworkPolicy).toHaveBeenCalledTimes(1);
    expect(setNetworkPolicy).toHaveBeenCalledWith("deny-all");
  });

  it("re-inspects the live detached checkout and rejects provenance or content drift", async () => {
    const fixture = sourceFixture();
    const receipt = inspectExistingRepositorySnapshotReceipt(fixture.snapshot);
    const source = await githubSource();
    const workspace = {
      workspaceId: "sandbox-source",
      workspacePath: "/workspace/repository" as const,
      sourcePath: "/workspace/repository",
      sourceSha,
      sourceTree,
      workspaceDigest: fixture.workspaceDigest,
      adapter: "arrusted-development-v0" as const,
      eligibilityDigest: receipt.eligibilityDigest,
    };
    const files = new Map<string, string>([
      [
        ".app-builder/prepared-workspace.json",
        `${JSON.stringify(workspace, null, 2)}\n`,
      ],
      [
        ".app-builder/source-files.json",
        `${JSON.stringify(fixture.sourceFiles, null, 2)}\n`,
      ],
      [
        ".app-builder/source-checksums.sha256",
        `${fixture.sourceFiles[0]!.sha256}  repository/microfrontends.json\n`,
      ],
      [
        ".app-builder/canonical-clone-inspection.json",
        JSON.stringify(fixture.snapshot),
      ],
    ]);
    let inspection = {
      remote: "https://github.com/withAutograph/app-builder-dogfood.git",
      resolvedRef: sourceSha,
      detached: true,
      hasGitmodules: false,
      gitlinks: [] as string[],
      manifestMatches: true,
      checksumsMatch: true,
      workspaceDigest: fixture.workspaceDigest,
      snapshot: fixture.snapshot,
    };
    const run = vi.fn(async ({ command }: { command: string }) => {
      if (command.includes("sha256sum"))
        return { exitCode: 0, stdout: "", stderr: "" };
      expect(command).toContain("--untracked-files=all");
      expect(command).toContain("(stat.mode & 0o777)");
      return {
        exitCode: 0,
        stdout: JSON.stringify(inspection),
        stderr: "",
      };
    });
    const setNetworkPolicy = vi.fn(async () => undefined);
    const sandbox = {
      id: workspace.workspaceId,
      readTextFile: vi.fn(
        async ({ path }: { path: string }) => files.get(path) ?? null,
      ),
      readBinaryFile: vi.fn(
        async ({ path }: { path: string }) =>
          path === "repository/microfrontends.json"
            ? fixture.sourceBytes
            : null,
      ),
      run,
      setNetworkPolicy,
    } as unknown as SandboxSession;

    await expect(
      inspectGitHubSourceSandboxWorkspace({
        sandbox,
        receipt,
        githubSource: source,
        expectedWorkspace: workspace,
      }),
    ).resolves.toEqual(workspace);
    inspection = { ...inspection, resolvedRef: "9".repeat(40) };
    await expect(
      inspectGitHubSourceSandboxWorkspace({
        sandbox,
        receipt,
        githubSource: source,
      }),
    ).rejects.toThrow("workspace drifted");
    inspection = {
      ...inspection,
      resolvedRef: sourceSha,
      gitlinks: ["vendor/submodule"],
    };
    await expect(
      inspectGitHubSourceSandboxWorkspace({
        sandbox,
        receipt,
        githubSource: source,
      }),
    ).rejects.toThrow("workspace drifted");
    inspection = {
      ...inspection,
      gitlinks: [],
      manifestMatches: false,
    };
    await expect(
      inspectGitHubSourceSandboxWorkspace({
        sandbox,
        receipt,
        githubSource: source,
      }),
    ).rejects.toThrow("workspace drifted");
    inspection = {
      ...inspection,
      manifestMatches: true,
      resolvedRef: sourceSha,
      snapshot: { ...fixture.snapshot, dirtyPaths: ["untracked.txt"] },
    };
    await expect(
      inspectGitHubSourceSandboxWorkspace({
        sandbox,
        receipt,
        githubSource: source,
      }),
    ).rejects.toThrow("workspace drifted");
    files.set(
      ".app-builder/canonical-clone-inspection.json",
      JSON.stringify({ ...fixture.snapshot, sourceTree: "8".repeat(40) }),
    );
    await expect(
      inspectGitHubSourceSandboxWorkspace({
        sandbox,
        receipt,
        githubSource: source,
      }),
    ).rejects.toThrow("stored GitHub source inspection drifted");
    expect(setNetworkPolicy).toHaveBeenLastCalledWith("deny-all");
  });

  it("refuses to mint an existing-repository receipt from a dirty snapshot", () => {
    const fixture = sourceFixture();
    expect(() =>
      inspectExistingRepositorySnapshotReceipt({
        ...fixture.snapshot,
        dirtyPaths: ["untracked.txt"],
      }),
    ).toThrow("inspection is not clean");
  });
});
