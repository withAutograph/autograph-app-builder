import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { SandboxSession } from "eve/sandbox";

import {
  acquireCanonicalArrustedTemplate,
  classifySandboxCloneFailure,
  inspectCanonicalArrustedSandboxWorkspace,
  sanitizeSandboxCloneError,
  sandboxCloneFailureStage,
  templateReadinessAttestationDigest,
} from "./arrusted-template";
import type { ArrustedTemplateReader } from "./arrusted-template-reader";
import { SUPPORTED_TEMPLATE_INPUT_PATHS } from "./supported-template";

const contractPaths = SUPPORTED_TEMPLATE_INPUT_PATHS;

describe("sandbox clone failure classification", () => {
  it.each([
    ["fatal: Authentication failed", "github-auth"],
    ["fatal: repository not found", "github-auth"],
    ["fatal: could not resolve host: github.com", "network"],
    ["operation timed out", "timeout"],
    ["fatal: unexpected git failure", "git-command"],
  ])("classifies a sanitized provider failure", (stderr, expected) => {
    expect(classifySandboxCloneFailure(stderr.toLowerCase())).toBe(expected);
  });

  it("reads only an allowlisted command stage from captured output", () => {
    expect(
      sandboxCloneFailureStage("fatal\nAUTOGRAPH_CLONE_STAGE=clone\n"),
    ).toBe("clone");
    expect(
      sandboxCloneFailureStage("AUTOGRAPH_CLONE_STAGE=anything-else"),
    ).toBeUndefined();
  });

  it("redacts credentials and URLs from bounded launch diagnostics", () => {
    const token = "ghs_sensitive_reader_token";
    const result = sanitizeSandboxCloneError(
      `fatal: ${token} at https://github.com/private/repo\npermission denied`,
      token,
    );
    expect(result).toBe("fatal: [redacted] at [url] permission denied");
    expect(result).not.toContain(token);
  });
});

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
    ".config/mise/tasks/repository/exec":
      '#!/usr/bin/env bash\nset -euo pipefail\nexec mise exec -- bun ".config/mise/scripts/repository/$1" "${@:2}"\n',
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
    "package.json":
      '{"name":"arrusted-template-fixture","private":true,"devDependencies":{"next":"16.3.3"}}\n',
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

describe("canonical Arrusted template readiness", () => {
  it("fails before sandbox preparation when the deployment reader is unavailable", async () => {
    const sandbox = {
      writeTextFile: vi.fn(),
      setNetworkPolicy: vi.fn(),
      run: vi.fn(),
    } as unknown as SandboxSession;
    const reader: ArrustedTemplateReader = {
      acquire: vi.fn(async () => {
        throw new Error("The Arrusted template reader is unavailable.");
      }),
    };

    await expect(
      acquireCanonicalArrustedTemplate({
        sandbox,
        callId: "call-template-reader-unavailable",
        reader,
      }),
    ).rejects.toThrow("template reader is unavailable");
    expect(sandbox.writeTextFile).not.toHaveBeenCalled();
    expect(sandbox.setNetworkPolicy).not.toHaveBeenCalled();
    expect(sandbox.run).not.toHaveBeenCalled();
  });

  it("uses one direct session clone for receipt inspection and workspace preparation", async () => {
    const reader: ArrustedTemplateReader = {
      acquire: vi.fn(async () => ({
        token: "ghs_reader_token_that_is_only_for_this_acquisition",
      })),
    };
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
    const contents = eligibleContents();
    const inspection = {
      sourcePath: "/workspace/repository",
      sourceSha,
      sourceTree,
      dirtyPaths: [],
      contents,
      contract: contractPaths.map((path) => ({
        path,
        mode:
          path === ".config/mise/tasks/repository/exec" ? "100755" : "100644",
        objectId: "d".repeat(40),
        sha256: createHash("sha256").update(contents[path]).digest("hex"),
      })),
    };
    const files = new Map<string, string>([
      [
        ".app-builder/source-files.json",
        `${JSON.stringify(sourceFiles, null, 2)}\n`,
      ],
      [
        ".app-builder/source-checksums.sha256",
        `${sourceFiles[0]!.sha256}  repository/microfrontends.json\n`,
      ],
      [
        ".app-builder/canonical-clone-inspection.json",
        JSON.stringify(inspection),
      ],
    ]);
    const setNetworkPolicy = vi.fn(async () => undefined);
    let reinspectionRemote =
      "https://github.com/withAutograph/arrusted-development.git";
    const run = vi.fn(async ({ command }: { command: string }) =>
      command.includes("arrusted-template-clone.sh")
        ? {
            exitCode: 0,
            stdout: JSON.stringify({
              sourceSha,
              sourceTree,
              workspaceDigest,
            }),
            stderr: "",
          }
        : command.includes("arrusted-template-reinspect.cjs")
          ? {
              exitCode: 0,
              stdout: JSON.stringify({
                remote: reinspectionRemote,
                resolvedRef: sourceSha,
                detached: true,
                hasGitmodules: false,
                gitlinks: [],
                manifestMatches: true,
                checksumsMatch: true,
                workspaceDigest,
                snapshot: inspection,
              }),
              stderr: "",
            }
          : { exitCode: 0, stdout: "", stderr: "" },
    );
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
      removePath: vi.fn(async ({ path }: { path: string }) => {
        files.delete(path);
      }),
      setNetworkPolicy,
      run,
    } as unknown as SandboxSession;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof globalThis.fetch>(async () =>
        Response.json({
          check_runs: [
            {
              id: 123,
              name: "Template readiness",
              status: "completed",
              conclusion: "success",
              head_sha: sourceSha,
              completed_at: "2026-08-31T16:01:00Z",
            },
          ],
        }),
      ),
    );
    const receipt = await acquireCanonicalArrustedTemplate({
      sandbox,
      callId: "call-template-clone",
      reader,
    });

    expect(receipt).toMatchObject({
      sourcePath: "/workspace/repository",
      sourceSha,
      sourceTree,
    });
    expect(JSON.stringify(receipt)).not.toContain(
      "ghs_reader_token_that_is_only_for_this_acquisition",
    );
    if (receipt.version !== 4) throw new Error("expected a V4 receipt");
    await inspectCanonicalArrustedSandboxWorkspace({ sandbox, receipt });
    expect(run.mock.calls[0]?.[0].command).toContain(
      "/bin/sh /workspace/.arrusted-template-clone.sh",
    );
    expect(run.mock.calls[0]?.[0].command).not.toContain(" clone ");
    const stagedCloneScript = vi
      .mocked(sandbox.writeTextFile)
      .mock.calls.find(
        ([call]) => call.path === ".arrusted-template-clone.sh",
      )?.[0].content;
    expect(stagedCloneScript).toContain(
      "clone --depth 1 --no-checkout --no-recurse-submodules --single-branch --branch main",
    );
    expect(stagedCloneScript).toContain("checkout --detach");
    expect(stagedCloneScript).toContain("core.hooksPath=/dev/null");
    expect(stagedCloneScript).toContain(
      "credential.helper=store --file=/workspace/.arrusted-template-reader-token",
    );
    expect(stagedCloneScript).toContain("stage credential");
    expect(stagedCloneScript).toContain('test -r "$credential"');
    expect(stagedCloneScript).not.toContain("chmod 600");
    expect(run.mock.calls[0]?.[0].command).toContain(
      "GIT_ASKPASS=/usr/bin/false",
    );
    expect(run.mock.calls[0]?.[0].command).not.toContain(
      "APP_BUILDER_TEMPLATE_ASKPASS_TOKEN_FILE",
    );
    expect(run.mock.calls[0]?.[0].command).toContain(
      "PATH=/usr/local/bin:/usr/bin:/bin",
    );
    expect(run.mock.calls[0]?.[0].command).toContain("TERM=dumb");
    expect(run.mock.calls[0]?.[0].env).toEqual({ TERM: "dumb" });
    expect(run.mock.calls[0]?.[0].command).not.toContain(
      "ghs_reader_token_that_is_only_for_this_acquisition",
    );
    const reinspection = run.mock.calls.find(([call]) =>
      call.command.includes("arrusted-template-reinspect.cjs"),
    )?.[0].command;
    expect(reinspection).toContain("arrusted-template-reinspect.cjs");
    expect(reinspection).toContain("PATH=/usr/local/bin:/usr/bin:/bin");
    expect(reinspection).toContain("TERM=dumb");
    expect(
      run.mock.calls.find(([call]) =>
        call.command.includes("arrusted-template-reinspect.cjs"),
      )?.[0].env,
    ).toEqual({ TERM: "dumb" });
    expect(reinspection).not.toContain(
      "ghs_reader_token_that_is_only_for_this_acquisition",
    );
    expect(files.has(".arrusted-template-reader-token")).toBe(false);
    expect(files.has(".arrusted-template-clone.sh")).toBe(false);
    expect(files.has(".arrusted-template-inspect.cjs")).toBe(false);
    expect(files.has(".arrusted-template-reinspect.cjs")).toBe(false);
    expect(reader.acquire).toHaveBeenCalledOnce();
    expect(setNetworkPolicy).toHaveBeenNthCalledWith(1, {
      allow: ["github.com"],
    });
    expect(setNetworkPolicy).toHaveBeenLastCalledWith("deny-all");
    reinspectionRemote =
      "https://github.com/withAutograph/another-private-template.git";
    await expect(
      inspectCanonicalArrustedSandboxWorkspace({ sandbox, receipt }),
    ).rejects.toThrow("workspace drifted");
    vi.unstubAllGlobals();
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
            head_sha: "a".repeat(40),
            started_at: "2026-08-31T16:00:00Z",
            completed_at: "2026-08-31T16:01:00Z",
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetch);

    const digest = await templateReadinessAttestationDigest({
      sha: "a".repeat(40),
      tree: "b".repeat(40),
      token: "ghs_reader_token_that_is_only_for_this_acquisition",
    });

    expect(digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(String(fetch.mock.calls[0]?.[0])).toBe(
      "https://api.github.com/repos/withAutograph/arrusted-development/commits/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/check-runs?per_page=100",
    );
    expect(
      new Headers(fetch.mock.calls[0]?.[1]?.headers).get("authorization"),
    ).toBe("token ghs_reader_token_that_is_only_for_this_acquisition");
    vi.unstubAllGlobals();
  });

  it("removes the clone credential and restores deny-all networking after a clone failure", async () => {
    const files = new Map<string, string>();
    const setNetworkPolicy = vi.fn(async () => undefined);
    const removePath = vi.fn(async ({ path }: { path: string }) => {
      files.delete(path);
    });
    const sandbox = {
      id: "sandbox-template-clone-failure",
      readTextFile: vi.fn(async () => null),
      writeTextFile: vi.fn(
        async ({ path, content }: { path: string; content: string }) => {
          files.set(path, content);
        },
      ),
      removePath,
      setNetworkPolicy,
      run: vi.fn(async () => ({ exitCode: 1, stdout: "", stderr: "failed" })),
    } as unknown as SandboxSession;
    const reader: ArrustedTemplateReader = {
      acquire: vi.fn(async () => ({
        token: "ghs_reader_token_that_is_only_for_this_acquisition",
      })),
    };

    await expect(
      acquireCanonicalArrustedTemplate({
        sandbox,
        callId: "call-template-clone-failure",
        reader,
      }),
    ).rejects.toThrow("clone could not be prepared");
    expect(files.has(".arrusted-template-reader-token")).toBe(false);
    expect(removePath).toHaveBeenCalledTimes(3);
    expect(setNetworkPolicy).toHaveBeenLastCalledWith("deny-all");
  });

  it.each(["credential-write", "network-enable"] as const)(
    "removes staged credentials and restores deny-all when %s fails",
    async (failure) => {
      const files = new Map<string, string>();
      const removePath = vi.fn(async ({ path }: { path: string }) => {
        files.delete(path);
      });
      const setNetworkPolicy = vi.fn(async (policy: unknown) => {
        if (failure === "network-enable" && policy !== "deny-all")
          throw new Error("network unavailable");
      });
      const sandbox = {
        id: `sandbox-template-${failure}`,
        readTextFile: vi.fn(async () => null),
        writeTextFile: vi.fn(
          async ({ path, content }: { path: string; content: string }) => {
            if (
              failure === "credential-write" &&
              path === ".arrusted-template-reader-token"
            )
              throw new Error("credential unavailable");
            files.set(path, content);
          },
        ),
        removePath,
        setNetworkPolicy,
        run: vi.fn(),
      } as unknown as SandboxSession;
      const reader: ArrustedTemplateReader = {
        acquire: vi.fn(async () => ({
          token: "ghs_reader_token_that_is_only_for_this_acquisition",
        })),
      };

      await expect(
        acquireCanonicalArrustedTemplate({
          sandbox,
          callId: `call-template-${failure}`,
          reader,
        }),
      ).rejects.toThrow();
      expect(files.has(".arrusted-template-reader-token")).toBe(false);
      expect(removePath).toHaveBeenCalledTimes(3);
      expect(setNetworkPolicy).toHaveBeenLastCalledWith("deny-all");
      expect(sandbox.run).not.toHaveBeenCalled();
    },
  );

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
              head_sha: "a".repeat(40),
              started_at: "2026-08-31T16:00:00Z",
              completed_at: "2026-08-31T16:01:00Z",
            },
          ],
        }),
      ),
    );

    await expect(
      templateReadinessAttestationDigest({
        sha: "a".repeat(40),
        tree: "b".repeat(40),
        token: "ghs_reader_token_that_is_only_for_this_acquisition",
      }),
    ).rejects.toThrow("no successful template-readiness evidence");
    vi.unstubAllGlobals();
  });

  it("rejects readiness evidence bound to another commit", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof globalThis.fetch>(async () =>
        Response.json({
          check_runs: [
            {
              id: 123,
              name: "Template readiness",
              status: "completed",
              conclusion: "success",
              head_sha: "c".repeat(40),
              started_at: "2026-08-31T16:00:00Z",
              completed_at: "2026-08-31T16:01:00Z",
            },
          ],
        }),
      ),
    );

    await expect(
      templateReadinessAttestationDigest({
        sha: "a".repeat(40),
        tree: "b".repeat(40),
        token: "ghs_reader_token_that_is_only_for_this_acquisition",
      }),
    ).rejects.toThrow("no successful template-readiness evidence");
    vi.unstubAllGlobals();
  });
});
