import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { SandboxSession } from "eve/sandbox";

import {
  acquireCanonicalArrustedTemplate,
  inspectCanonicalArrustedSandboxWorkspace,
  templateReadinessAttestationDigest,
} from "./arrusted-template";

const contractPaths = [
  ".config/mise/config.toml",
  ".github/workflows/cd.yml",
  "microfrontends.json",
  ".config/mise/scripts/repository/app-contract.ts",
  ".config/mise/scripts/repository/app-identity.ts",
  ".config/mise/scripts/repository/app-validation.ts",
  ".config/mise/scripts/repository/repository-preflight.ts",
  ".config/turbo/generators/config.ts",
  ".config/turbo/generators/create-app.ts",
  ".config/turbo/generators/templates/app/next.config.ts.hbs",
] as const;

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

describe("canonical Arrusted template readiness", () => {
  it("uses one direct session clone for receipt inspection and workspace preparation", async () => {
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
        mode: "100644",
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
    const run = vi
      .fn()
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify({ sourceSha, sourceTree, workspaceDigest }),
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
              completed_at: "2026-08-31T16:01:00Z",
            },
          ],
        }),
      ),
    );
    const receipt = await acquireCanonicalArrustedTemplate({
      sandbox,
      callId: "call-template-clone",
    });

    expect(receipt).toMatchObject({
      sourcePath: "/workspace/repository",
      sourceSha,
      sourceTree,
    });
    if (receipt.version !== 4) throw new Error("expected a V4 receipt");
    await inspectCanonicalArrustedSandboxWorkspace({ sandbox, receipt });
    expect(
      run.mock.calls.filter(([call]) =>
        String(call.command).includes(" clone "),
      ),
    ).toHaveLength(1);
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
