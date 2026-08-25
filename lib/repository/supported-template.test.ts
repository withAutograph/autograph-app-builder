import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { SandboxSession } from "eve/sandbox";

import {
  inspectPreparedSandboxWorkspace,
  inspectSupportedRepository,
  prepareSupportedSandboxWorkspace,
} from "./supported-template";
import { inspectSourceReceipt } from "./source-receipt";

const previousRoots = process.env.REPOSITORY_LOCAL_ROOTS;
const previousWorkspaceRoot = process.env.REPOSITORY_WORKSPACE_ROOT;

afterEach(() => {
  if (previousRoots === undefined) delete process.env.REPOSITORY_LOCAL_ROOTS;
  else process.env.REPOSITORY_LOCAL_ROOTS = previousRoots;
  if (previousWorkspaceRoot === undefined)
    delete process.env.REPOSITORY_WORKSPACE_ROOT;
  else process.env.REPOSITORY_WORKSPACE_ROOT = previousWorkspaceRoot;
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "supported-template-"));
  const files: Record<string, string> = {
    ".config/mise/config.toml": [
      '[tasks."create:app"]',
      "run = 'mise exec -- bun .config/turbo/generators/create-app.ts --proposal \"$usage_proposal\"'",
      "",
      '[tasks."repository:preflight"]',
      'run = "mise run repository:exec -- repository-preflight.ts"',
      "",
      '[tasks."generate:app"]',
      "run = 'turbo gen --config .config/turbo/generators/config.ts app --args \"$usage_app_id\"'",
      "",
      '[tasks."repository:exec"]',
      'run = "bun .config/mise/scripts/repository/$usage_script"',
    ].join("\n"),
    ".github/workflows/cd.yml": [
      "jobs:",
      "  release-gate:",
      "    name: Authorize (Repository release gate)",
      "    permissions:",
      "      actions: read",
      "    steps:",
      "      - run: REPOSITORY_RELEASE_ENABLED",
      "  preflight:",
      "    if: needs.release-gate.outputs.enabled == 'true'",
    ].join("\n"),
    "apps/shell/microfrontends.json": "{}\n",
    ".config/mise/scripts/repository/app-contract.ts":
      'const source = { runtime: "nextjs" };\n',
    ".config/mise/scripts/repository/app-identity.ts":
      'const scope = "@autograph/${appId}";\n',
    ".config/mise/scripts/repository/repository-preflight.ts": [
      'const observed = { runtime: "nextjs" };',
      'const appIdentity = "mise run repository:exec -- app-identity.ts --app <app-id>";',
      'const appPlan = "mise run repository:exec -- app-contract.ts --contract <contract-file>";',
      'const appApply = "mise run create:app -- --proposal <proposal-file>";',
      'const preflight = "mise run repository:preflight";',
      'const validation = ["mise run check", "mise run test"];',
    ].join("\n"),
    ".config/mise/scripts/repository/repository-release-gate.sh": [
      'gh api "repos/$GITHUB_REPOSITORY/actions/variables/REPOSITORY_RELEASE_ENABLED"',
      'if [[ "$value" == "true" ]]; then',
    ].join("\n"),
    ".config/turbo/generators/config.ts": 'const scope = "autograph";\n',
    ".config/turbo/generators/create-app.ts": "export {};\n",
    ".config/turbo/generators/templates/app/next.config.ts.hbs":
      "export default {};\n",
  };
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, path);
    mkdirSync(join(absolute, ".."), { recursive: true });
    writeFileSync(absolute, content);
  }
  execFileSync("git", ["init", "-b", "main"], { cwd: root });
  execFileSync("git", ["add", "--", ...Object.keys(files)], { cwd: root });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "fixture",
    ],
    {
      cwd: root,
    },
  );
  return root;
}

function cloneFixture(root: string): string {
  const destination = join(
    mkdtempSync(join(tmpdir(), "supported-template-clone-")),
    "repository",
  );
  execFileSync("git", [
    "clone",
    "--quiet",
    "--no-hardlinks",
    root,
    destination,
  ]);
  return destination;
}

function allowRepositories(...roots: string[]): void {
  process.env.REPOSITORY_LOCAL_ROOTS = roots.join(delimiter);
}

function fakeSandbox({
  createParentsOnWrite = true,
}: { createParentsOnWrite?: boolean } = {}): SandboxSession {
  const root = mkdtempSync(join(tmpdir(), "builder-sandbox-"));
  return {
    id: `sandbox-${root.split("-").at(-1)}`,
    resolvePath: (path: string) => resolve(root, path),
    readTextFile: async ({ path }: { path: string }) => {
      try {
        return readFileSync(resolve(root, path), "utf8");
      } catch {
        return null;
      }
    },
    readBinaryFile: async ({ path }: { path: string }) => {
      try {
        return readFileSync(resolve(root, path));
      } catch {
        return null;
      }
    },
    writeTextFile: async ({
      path,
      content,
    }: {
      path: string;
      content: string;
    }) => {
      const target = resolve(root, path);
      if (createParentsOnWrite)
        mkdirSync(resolve(target, ".."), { recursive: true });
      writeFileSync(target, content);
    },
    writeBinaryFile: async ({
      path,
      content,
    }: {
      path: string;
      content: Uint8Array;
    }) => {
      const target = resolve(root, path);
      if (createParentsOnWrite)
        mkdirSync(resolve(target, ".."), { recursive: true });
      writeFileSync(target, content);
    },
    removePath: async ({ path }: { path: string }) => {
      rmSync(resolve(root, path), { recursive: true, force: true });
    },
    run: async ({ command }: { command: string }) => {
      try {
        return {
          exitCode: 0,
          stdout: execFileSync("sh", ["-c", command], {
            cwd: root,
            encoding: "utf8",
          }),
          stderr: "",
        };
      } catch (error) {
        const stderr =
          error instanceof Error &&
          "stderr" in error &&
          Buffer.isBuffer(error.stderr)
            ? error.stderr.toString("utf8")
            : error instanceof Error
              ? error.message
              : String(error);
        const exitCode =
          error instanceof Error &&
          "status" in error &&
          typeof error.status === "number"
            ? error.status
            : 1;
        return {
          exitCode,
          stdout: "",
          stderr,
        };
      }
    },
  } as unknown as SandboxSession;
}

describe("supported-template adapter", () => {
  it("keeps canonical eligibility stable across physical source paths", async () => {
    const firstRoot = fixture();
    const secondRoot = cloneFixture(firstRoot);
    allowRepositories(firstRoot, secondRoot);

    const first = await inspectSupportedRepository(firstRoot);
    const second = await inspectSupportedRepository(secondRoot);

    expect(first.sourcePath).not.toBe(second.sourcePath);
    expect(first.sourceSha).toBe(second.sourceSha);
    expect(first.dirtyPaths).toEqual(second.dirtyPaths);
    expect(first.failures).toEqual(second.failures);
    expect(first.observed).toEqual(second.observed);
    expect(first.digest).toBe(second.digest);
  });

  it("binds canonical eligibility to SHA, dirty state, and observations", async () => {
    const shaRoot = fixture();
    process.env.REPOSITORY_LOCAL_ROOTS = shaRoot;
    const beforeSha = await inspectSupportedRepository(shaRoot);
    writeFileSync(join(shaRoot, "README.md"), "advance source\n");
    execFileSync("git", ["add", "README.md"], { cwd: shaRoot });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-m",
        "advance fixture",
      ],
      { cwd: shaRoot },
    );
    const afterSha = await inspectSupportedRepository(shaRoot);
    expect(afterSha.sourceSha).not.toBe(beforeSha.sourceSha);
    expect(afterSha.dirtyPaths).toEqual(beforeSha.dirtyPaths);
    expect(afterSha.observed).toEqual(beforeSha.observed);
    expect(afterSha.digest).not.toBe(beforeSha.digest);

    const dirtyRoot = fixture();
    process.env.REPOSITORY_LOCAL_ROOTS = dirtyRoot;
    const beforeDirty = await inspectSupportedRepository(dirtyRoot);
    writeFileSync(join(dirtyRoot, "README.md"), "dirty source\n");
    const afterDirty = await inspectSupportedRepository(dirtyRoot);
    expect(afterDirty.sourceSha).toBe(beforeDirty.sourceSha);
    expect(afterDirty.dirtyPaths).not.toEqual(beforeDirty.dirtyPaths);
    expect(afterDirty.observed).toEqual(beforeDirty.observed);
    expect(afterDirty.digest).not.toBe(beforeDirty.digest);

    const supportedRoot = fixture();
    const driftedRoot = cloneFixture(supportedRoot);
    const contractPath = ".config/mise/scripts/repository/app-contract.ts";
    writeFileSync(
      join(supportedRoot, contractPath),
      'const source = { runtime: "nextjs" };\n// same dirty path\n',
    );
    writeFileSync(
      join(driftedRoot, contractPath),
      'const source = { runtime: "vite" };\n// same dirty path\n',
    );
    allowRepositories(supportedRoot, driftedRoot);
    const supported = await inspectSupportedRepository(supportedRoot);
    const drifted = await inspectSupportedRepository(driftedRoot);
    expect(drifted.sourceSha).toBe(supported.sourceSha);
    expect(drifted.dirtyPaths).toEqual(supported.dirtyPaths);
    expect(drifted.observed).not.toEqual(supported.observed);
    expect(drifted.digest).not.toBe(supported.digest);
  });

  it("emits kind-specific canonical release-disabled source receipts", async () => {
    const root = fixture();
    process.env.REPOSITORY_LOCAL_ROOTS = root;
    const existing = await inspectSourceReceipt("existing-repository", root);
    const fresh = await inspectSourceReceipt("fresh-template", root);
    expect(existing.sourceSha).toBe(fresh.sourceSha);
    expect(existing.contractDigest).toBe(fresh.contractDigest);
    expect(existing.digest).not.toBe(fresh.digest);
    expect(fresh.releaseEnabled).toBe(false);
    await expect(inspectSourceReceipt("fresh-template", root)).resolves.toEqual(
      fresh,
    );
  });

  it("keeps the reviewed-object contract stable while dirty eligibility drifts", async () => {
    const root = fixture();
    process.env.REPOSITORY_LOCAL_ROOTS = root;
    const reviewed = await inspectSourceReceipt("fresh-template", root);
    writeFileSync(
      join(root, ".config/mise/config.toml"),
      `${readFileSync(join(root, ".config/mise/config.toml"), "utf8")}\n# drift\n`,
    );
    const drifted = await inspectSourceReceipt("fresh-template", root);
    expect(drifted.sourceSha).toBe(reviewed.sourceSha);
    expect(drifted.eligibilityDigest).not.toBe(reviewed.eligibilityDigest);
    expect(drifted.contractDigest).toBe(reviewed.contractDigest);
    expect(drifted.digest).not.toBe(reviewed.digest);
  });

  it("accepts only the closed V0 surface and prepares the exact SHA", async () => {
    const root = fixture();
    process.env.REPOSITORY_LOCAL_ROOTS = root;
    const eligibility = await inspectSupportedRepository(root);
    expect(eligibility.eligible).toBe(true);
    expect(eligibility.observed.runtime).toBe("nextjs");
    expect(eligibility.observed.planningCommand).toBe(
      "mise run repository:exec -- app-contract.ts --contract <contract-file>",
    );
    expect(eligibility.observed.scaffoldCommand).toBe(
      "mise run generate:app <app-id>",
    );
    const sandbox = fakeSandbox();
    const prepared = await prepareSupportedSandboxWorkspace(
      root,
      eligibility.sourceSha!,
      eligibility.digest,
      sandbox,
      "call_prepare",
    );
    expect(
      readFileSync(
        resolve(
          sandbox.resolvePath("repository"),
          "apps/shell/microfrontends.json",
        ),
        "utf8",
      ),
    ).toBe("{}\n");
    expect(prepared.sourceTree).toMatch(/^[0-9a-f]{40}$/u);
    expect(prepared.workspaceDigest).toMatch(/^[0-9a-f]{64}$/u);
    await expect(inspectPreparedSandboxWorkspace(sandbox)).resolves.toEqual({
      state: "prepared",
      workspace: prepared,
    });
    await expect(
      prepareSupportedSandboxWorkspace(
        root,
        eligibility.sourceSha!,
        eligibility.digest,
        sandbox,
        "call_replayed",
      ),
    ).resolves.toEqual(prepared);

    writeFileSync(
      resolve(
        sandbox.resolvePath("repository"),
        "apps/shell/microfrontends.json",
      ),
      "tampered\n",
    );
    await expect(
      prepareSupportedSandboxWorkspace(
        root,
        eligibility.sourceSha!,
        eligibility.digest,
        sandbox,
        "call_lost_response",
      ),
    ).rejects.toThrow("A prepared workspace file drifted or is missing.");
  });

  it("creates parent directories when sandbox writes do not", async () => {
    const root = fixture();
    process.env.REPOSITORY_LOCAL_ROOTS = root;
    const eligibility = await inspectSupportedRepository(root);
    const sandbox = fakeSandbox({ createParentsOnWrite: false });

    const prepared = await prepareSupportedSandboxWorkspace(
      root,
      eligibility.sourceSha!,
      eligibility.digest,
      sandbox,
      "call_prepare",
    );

    expect(
      readFileSync(
        resolve(
          sandbox.resolvePath("repository"),
          "apps/shell/microfrontends.json",
        ),
        "utf8",
      ),
    ).toBe("{}\n");
    await expect(inspectPreparedSandboxWorkspace(sandbox)).resolves.toEqual({
      state: "prepared",
      workspace: prepared,
    });
  });

  it("rejects reuse when the durable prepared source tree drifts", async () => {
    const root = fixture();
    process.env.REPOSITORY_LOCAL_ROOTS = root;
    const eligibility = await inspectSupportedRepository(root);
    const sandbox = fakeSandbox();
    await prepareSupportedSandboxWorkspace(
      root,
      eligibility.sourceSha!,
      eligibility.digest,
      sandbox,
      "call_prepare",
    );
    const recordPath = resolve(
      sandbox.resolvePath(".app-builder"),
      "prepared-workspace.json",
    );
    const record = JSON.parse(readFileSync(recordPath, "utf8")) as Record<
      string,
      unknown
    >;
    writeFileSync(
      recordPath,
      `${JSON.stringify({ ...record, sourceTree: "0".repeat(40) })}\n`,
    );

    await expect(
      prepareSupportedSandboxWorkspace(
        root,
        eligibility.sourceSha!,
        eligibility.digest,
        sandbox,
        "call_reuse",
      ),
    ).rejects.toThrow("already owns a different workspace");
  });

  it("reports an absent workspace and rejects a malformed durable record", async () => {
    const sandbox = fakeSandbox();
    await expect(inspectPreparedSandboxWorkspace(sandbox)).resolves.toEqual({
      state: "absent",
    });
    mkdirSync(sandbox.resolvePath(".app-builder"), { recursive: true });
    writeFileSync(
      resolve(sandbox.resolvePath(".app-builder"), "prepared-workspace.json"),
      '{"workspaceId":"partial"}\n',
    );
    await expect(inspectPreparedSandboxWorkspace(sandbox)).rejects.toThrow(
      "The prepared workspace record is invalid.",
    );
  });

  it("rejects a source SHA that changes while approval is pending", async () => {
    const root = fixture();
    process.env.REPOSITORY_LOCAL_ROOTS = root;
    const eligibility = await inspectSupportedRepository(root);
    writeFileSync(join(root, "README.md"), "new commit\n");
    execFileSync("git", ["add", "README.md"], { cwd: root });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-m",
        "advance fixture",
      ],
      { cwd: root },
    );
    await expect(
      prepareSupportedSandboxWorkspace(
        root,
        eligibility.sourceSha!,
        eligibility.digest,
        fakeSandbox(),
        "call_prepare",
      ),
    ).rejects.toThrow("Source SHA changed after eligibility review.");
  });

  it("rejects a workspace approval bound to a stale eligibility digest", async () => {
    const root = fixture();
    process.env.REPOSITORY_LOCAL_ROOTS = root;
    const eligibility = await inspectSupportedRepository(root);
    await expect(
      prepareSupportedSandboxWorkspace(
        root,
        eligibility.sourceSha!,
        "0".repeat(64),
        fakeSandbox(),
        "call_prepare",
      ),
    ).rejects.toThrow("Repository eligibility changed after review.");
  });

  it("fails closed when the planner still declares Vite", async () => {
    const root = fixture();
    writeFileSync(
      join(root, ".config/mise/scripts/repository/app-contract.ts"),
      'const source = { runtime: "vite" };\n',
    );
    process.env.REPOSITORY_LOCAL_ROOTS = root;
    const eligibility = await inspectSupportedRepository(root);
    expect(eligibility.eligible).toBe(false);
    expect(eligibility.failures).toContain(
      "app planner does not declare the Next.js runtime",
    );
  });

  it("rejects legacy adapter paths instead of inferring replacements", async () => {
    const root = fixture();
    const current = join(root, ".config/turbo/generators/create-app.ts");
    const legacy = join(root, "turbo/generators/create-app.ts");
    mkdirSync(join(legacy, ".."), { recursive: true });
    writeFileSync(legacy, "export {};\n");
    unlinkSync(current);
    process.env.REPOSITORY_LOCAL_ROOTS = root;
    const eligibility = await inspectSupportedRepository(root);
    expect(eligibility.eligible).toBe(false);
    expect(eligibility.failures).toContain(
      "missing required path .config/turbo/generators/create-app.ts",
    );
  });

  it("rejects alternate release-gate declarations", async () => {
    const root = fixture();
    writeFileSync(
      join(root, ".github/workflows/cd.yml"),
      "jobs:\n  release-gate:\n    name: something else\n",
    );
    process.env.REPOSITORY_LOCAL_ROOTS = root;
    const eligibility = await inspectSupportedRepository(root);
    expect(eligibility.eligible).toBe(false);
    expect(eligibility.failures).toContain(
      "REPOSITORY_RELEASE_ENABLED gate is not the supported CD gate",
    );
  });
});
