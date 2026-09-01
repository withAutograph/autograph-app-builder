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
  assertPreparedSandboxReleasePolicy,
  assertRepositoryReleasePolicyAtGitSnapshot,
  inspectSupportedTemplateDependencyClosure,
  inspectPreparedSandboxWorkspace,
  inspectSupportedRepository,
  prepareSupportedSandboxWorkspace,
  SUPPORTED_REPOSITORY_CONTRACT,
  SUPPORTED_TEMPLATE_DEPENDENCY_PATHS,
} from "./supported-template";
import {
  ARRUSTED_TEMPLATE_REF,
  ARRUSTED_TEMPLATE_REPOSITORY,
  inspectSourceReceipt,
  inspectClonedTemplateSourceReceipt,
  parseSourceReceipt,
  parseSourceReceiptEvidence,
  sourceReceiptEvidence,
} from "./source-receipt";

const previousRoots = process.env.REPOSITORY_LOCAL_ROOTS;
const previousWorkspaceRoot = process.env.REPOSITORY_WORKSPACE_ROOT;

function fixtureGit(root: string, args: string[]): void {
  execFileSync(
    "git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.excludesfile=/dev/null",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd: root, env: { ...process.env, HK: "0" } },
  );
}

function commitFixture(root: string, message: string): void {
  fixtureGit(root, ["add", "--all"]);
  fixtureGit(root, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    message,
  ]);
}

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
      "",
      '[tasks."app:check-build"]',
      "run = 'bun .config/mise/scripts/repository/app-validation.ts check-build \"$usage_app\"'",
      "",
      '[tasks."app:test"]',
      'run = \'bun .config/mise/scripts/repository/app-validation.ts test "$usage_app" "$usage_shard"\'',
    ].join("\n"),
    ".config/mise/tasks/repository/exec": [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'exec mise exec -- bun ".config/mise/scripts/repository/$1" "${@:2}"',
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
    "package.json": `${JSON.stringify(
      {
        name: "supported-template-fixture",
        private: true,
        devDependencies: { next: "16.3.3" },
      },
      null,
      2,
    )}\n`,
    ".config/mise/scripts/repository/app-contract.ts":
      'const source = { runtime: "nextjs" };\n',
    ".config/mise/scripts/repository/app-identity.ts":
      'const scope = "@autograph/${appId}";\n',
    ".config/mise/scripts/repository/app-validation.ts": "export {};\n",
    ".config/mise/scripts/repository/repository-preflight.ts": [
      'const observed = { runtime: "nextjs" };',
      'const appIdentity = "mise run repository:exec -- app-identity.ts --app <app-id>";',
      'const appPlan = "mise run repository:exec -- app-contract.ts --contract <contract-file>";',
      'const appApply = "mise run create:app -- --proposal <proposal-file>";',
      'const preflight = "mise run repository:preflight";',
      'const validation = ["mise run app:check-build <app-id>", "mise run app:test <app-id> <shard>"];',
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
  fixtureGit(root, ["init", "-b", "main"]);
  fixtureGit(root, ["add", "--", ...Object.keys(files)]);
  fixtureGit(root, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "fixture",
  ]);
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
  it("binds canonical clone provenance in a V4 fresh-template receipt", async () => {
    const root = fixture();
    const receipt = await inspectClonedTemplateSourceReceipt({
      path: root,
      readinessDigest: "a".repeat(64),
    });

    expect(receipt.version).toBe(4);
    expect(receipt.sourceKind).toBe("fresh-template");
    if (receipt.version !== 4) throw new Error("expected V4 clone receipt");
    expect(receipt.provenance).toEqual({
      repository: ARRUSTED_TEMPLATE_REPOSITORY,
      ref: ARRUSTED_TEMPLATE_REF,
      method: "git-clone-v1",
      readinessDigest: "a".repeat(64),
    });
    expect(() =>
      parseSourceReceipt({
        ...receipt,
        provenance: { ...receipt.provenance, ref: "refs/heads/other" },
      }),
    ).toThrow("Source receipt evidence is invalid");
  });

  it("declares a complete immutable inspection entrypoint closure", () => {
    expect(SUPPORTED_TEMPLATE_DEPENDENCY_PATHS).toEqual([
      ".config/mise/config.toml",
      ".config/mise/mise.lock",
      ".config/mise/scripts/trusted-node-launcher",
      ".config/mise/tasks/source/inspect",
      "lib/repository/sandbox-filesystem.ts",
      "lib/repository/source-path.ts",
      "lib/repository/source-receipt.ts",
      "lib/repository/supported-template.ts",
      "lib/testing/test-capability.ts",
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "scripts/inspect-source-receipt.mts",
      "tsconfig.json",
    ]);
    const repositoryRoot = resolve(import.meta.dirname, "../..");
    const closureRoot = mkdtempSync(join(tmpdir(), "adapter-closure-"));
    for (const path of SUPPORTED_TEMPLATE_DEPENDENCY_PATHS) {
      const destination = join(closureRoot, path);
      mkdirSync(resolve(destination, ".."), { recursive: true });
      writeFileSync(destination, readFileSync(join(repositoryRoot, path)));
    }
    fixtureGit(closureRoot, ["init", "-b", "main"]);
    fixtureGit(closureRoot, [
      "add",
      "--",
      ...SUPPORTED_TEMPLATE_DEPENDENCY_PATHS,
    ]);
    fixtureGit(closureRoot, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "closure fixture",
    ]);
    const closure = inspectSupportedTemplateDependencyClosure(closureRoot);
    expect(closure.files.map(({ path }) => path)).toEqual([
      ...SUPPORTED_TEMPLATE_DEPENDENCY_PATHS,
    ]);
    expect(
      closure.files.every(({ sha256 }) => /^[0-9a-f]{64}$/u.test(sha256)),
    ).toBe(true);
    expect(closure.digest).toMatch(/^[0-9a-f]{64}$/u);
  });

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
    fixtureGit(shaRoot, ["add", "README.md"]);
    fixtureGit(shaRoot, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "advance fixture",
    ]);
    const afterSha = await inspectSupportedRepository(shaRoot);
    expect(afterSha.sourceSha).not.toBe(beforeSha.sourceSha);
    expect(afterSha.dirtyPaths).toEqual(beforeSha.dirtyPaths);
    expect(afterSha.observed).toEqual(beforeSha.observed);
    expect(afterSha.compatibilityDigest).toBe(beforeSha.compatibilityDigest);
    expect(afterSha.digest).not.toBe(beforeSha.digest);

    const dirtyRoot = fixture();
    process.env.REPOSITORY_LOCAL_ROOTS = dirtyRoot;
    const beforeDirty = await inspectSupportedRepository(dirtyRoot);
    writeFileSync(join(dirtyRoot, "README.md"), "dirty source\n");
    const afterDirty = await inspectSupportedRepository(dirtyRoot);
    expect(afterDirty.sourceSha).toBe(beforeDirty.sourceSha);
    expect(afterDirty.dirtyPaths).not.toEqual(beforeDirty.dirtyPaths);
    expect(afterDirty.observed).toEqual(beforeDirty.observed);
    expect(afterDirty.compatibilityDigest).toBe(
      beforeDirty.compatibilityDigest,
    );
    expect(afterDirty.digest).not.toBe(beforeDirty.digest);
  });

  it("reads required compatibility bytes from the selected Git snapshot in both dirty directions", async () => {
    const root = fixture();
    process.env.REPOSITORY_LOCAL_ROOTS = root;
    const contractPath = ".config/mise/config.toml";
    const supportedSource = readFileSync(join(root, contractPath), "utf8");
    const unsupportedSource = supportedSource.replace(
      '[tasks."app:test"]',
      '[tasks."renamed:test"]',
    );
    const supported = await inspectSupportedRepository(root);

    writeFileSync(join(root, contractPath), unsupportedSource);
    const dirtyUnsupported = await inspectSupportedRepository(root);
    expect(dirtyUnsupported.sourceSha).toBe(supported.sourceSha);
    expect(dirtyUnsupported.dirtyPaths).toContain(contractPath);
    expect(dirtyUnsupported.planningEligible).toBe(true);
    expect(dirtyUnsupported.compatibilityDigest).toBe(
      supported.compatibilityDigest,
    );

    commitFixture(root, "commit unsupported contract");
    const committedUnsupported = await inspectSupportedRepository(root);
    expect(committedUnsupported.planningEligible).toBe(false);
    expect(committedUnsupported.planningFailures).toContain(
      "app:test command is missing",
    );

    writeFileSync(join(root, contractPath), supportedSource);
    const dirtySupported = await inspectSupportedRepository(root);
    expect(dirtySupported.sourceSha).toBe(committedUnsupported.sourceSha);
    expect(dirtySupported.dirtyPaths).toContain(contractPath);
    expect(dirtySupported.planningEligible).toBe(false);
    expect(dirtySupported.compatibilityDigest).toBe(
      committedUnsupported.compatibilityDigest,
    );
  });

  it("emits kind-specific canonical release-disabled source receipts", async () => {
    const root = fixture();
    process.env.REPOSITORY_LOCAL_ROOTS = root;
    const existing = await inspectSourceReceipt("existing-repository", root);
    const fresh = await inspectSourceReceipt("fresh-template", root);
    expect(existing.sourceSha).toBe(fresh.sourceSha);
    expect(existing.eligibilityDigest).not.toBe(fresh.eligibilityDigest);
    expect(existing.contractDigest).not.toBe(fresh.contractDigest);
    expect(existing.digest).not.toBe(fresh.digest);
    expect(fresh.releaseEnabled).toBe(false);
    await expect(inspectSourceReceipt("fresh-template", root)).resolves.toEqual(
      fresh,
    );
  });

  it("rebinds receipt evidence when an eligible normalized input changes", async () => {
    const root = fixture();
    process.env.REPOSITORY_LOCAL_ROOTS = root;
    const before = await inspectSourceReceipt("existing-repository", root);
    const misePath = join(root, ".config/mise/config.toml");
    writeFileSync(
      misePath,
      `${readFileSync(misePath, "utf8")}\n[tasks."unrelated:check"]\ndescription = "Additional repository check"\nrun = "true"\n`,
    );
    fixtureGit(root, ["add", "--", ".config/mise/config.toml"]);
    fixtureGit(root, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "advance eligible input",
    ]);

    const eligibility = await inspectSupportedRepository(root);
    const after = await inspectSourceReceipt("existing-repository", root);
    expect(eligibility.eligible).toBe(true);
    expect(after.sourceSha).not.toBe(before.sourceSha);
    expect(after.sourceTree).not.toBe(before.sourceTree);
    expect(after.eligibilityDigest).toBe(before.eligibilityDigest);
    expect(after.contractDigest).not.toBe(before.contractDigest);
    expect(after.digest).not.toBe(before.digest);
  });

  it("keeps source evidence reproducible across physical checkout paths", async () => {
    const firstRoot = fixture();
    const secondRoot = cloneFixture(firstRoot);
    allowRepositories(firstRoot, secondRoot);

    const first = await inspectSourceReceipt("fresh-template", firstRoot);
    const second = await inspectSourceReceipt("fresh-template", secondRoot);

    expect(first.sourcePath).not.toBe(second.sourcePath);
    expect(first.version).toBe(3);
    expect(second.version).toBe(3);
    expect(first.digest).toBe(second.digest);
    expect(sourceReceiptEvidence(first)).toEqual(sourceReceiptEvidence(second));

    const relocated = parseSourceReceipt({
      ...first,
      sourcePath: second.sourcePath,
    });
    expect(relocated.digest).toBe(first.digest);
    expect(sourceReceiptEvidence(relocated)).toEqual(
      sourceReceiptEvidence(first),
    );
  });

  it("parses only exact V3 path-independent source evidence", async () => {
    const root = fixture();
    process.env.REPOSITORY_LOCAL_ROOTS = root;
    const receipt = await inspectSourceReceipt("existing-repository", root);
    const evidence = sourceReceiptEvidence(receipt);

    expect(parseSourceReceiptEvidence(evidence)).toEqual(evidence);
    expect(
      parseSourceReceiptEvidence(
        Object.fromEntries(Object.entries(evidence).toReversed()),
      ),
    ).toEqual(evidence);
    expect(() =>
      parseSourceReceiptEvidence({ ...evidence, version: 2 }),
    ).toThrow("invalid");
    expect(() =>
      parseSourceReceiptEvidence({ ...evidence, sourcePath: root }),
    ).toThrow("unsupported schema");
    expect(() =>
      parseSourceReceiptEvidence({
        ...evidence,
        sourceSha: "0".repeat(40),
      }),
    ).toThrow("digest");
    expect(() =>
      parseSourceReceiptEvidence({
        ...evidence,
        sourceTree: "0".repeat(40),
      }),
    ).toThrow("digest");
    expect(() =>
      parseSourceReceiptEvidence({
        ...evidence,
        eligibilityDigest: "0".repeat(64),
      }),
    ).toThrow("digest");
    expect(() =>
      parseSourceReceiptEvidence({
        ...evidence,
        contractDigest: "0".repeat(64),
      }),
    ).toThrow("digest");
    expect(() =>
      parseSourceReceiptEvidence({
        ...evidence,
        digest: "0".repeat(64),
      }),
    ).toThrow("digest");
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

  it("rejects the retired shell-owned topology path", async () => {
    const root = fixture();
    const topology = join(root, "microfrontends.json");
    const retiredTopology = join(root, "apps/shell/microfrontends.json");
    mkdirSync(resolve(retiredTopology, ".."), { recursive: true });
    writeFileSync(retiredTopology, readFileSync(topology));
    unlinkSync(topology);
    fixtureGit(root, ["add", "--all"]);
    fixtureGit(root, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "restore retired topology path",
    ]);
    process.env.REPOSITORY_LOCAL_ROOTS = root;

    const eligibility = await inspectSupportedRepository(root);

    expect(eligibility.eligible).toBe(false);
    expect(eligibility.failures).toContain(
      "missing required path microfrontends.json",
    );
  });

  it("accepts the declared planning contract and prepares the exact SHA", async () => {
    const root = fixture();
    process.env.REPOSITORY_LOCAL_ROOTS = root;
    const eligibility = await inspectSupportedRepository(root);
    expect(eligibility.eligible).toBe(true);
    expect(eligibility.planningEligible).toBe(true);
    expect(eligibility.compatibilityDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(eligibility.observed.contractVersion).toBe(
      SUPPORTED_REPOSITORY_CONTRACT.version,
    );
    expect(eligibility.observed.requiredPaths).toEqual(
      SUPPORTED_REPOSITORY_CONTRACT.requiredPaths,
    );
    expect(eligibility.observed.runtime).toBe("nextjs");
    expect(eligibility.observed.planningCommand).toBe(
      "mise run repository:exec -- app-contract.ts --contract <contract-file>",
    );
    expect(eligibility.releasePolicy).toEqual({
      gate: "REPOSITORY_RELEASE_ENABLED",
      eligible: true,
    });
    const releasePolicy = assertRepositoryReleasePolicyAtGitSnapshot({
      sourcePath: eligibility.sourcePath,
      sourceSha: eligibility.sourceSha!,
      sourceTree: execFileSync(
        "git",
        ["rev-parse", `${eligibility.sourceSha}^{tree}`],
        { cwd: eligibility.sourcePath, encoding: "utf8" },
      ).trim(),
    });
    expect(releasePolicy.eligible).toBe(true);
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
        resolve(sandbox.resolvePath("repository"), "microfrontends.json"),
        "utf8",
      ),
    ).toBe("{}\n");
    expect(prepared.sourceTree).toMatch(/^[0-9a-f]{40}$/u);
    expect(prepared.workspaceDigest).toMatch(/^[0-9a-f]{64}$/u);
    await expect(
      assertPreparedSandboxReleasePolicy({
        sandbox,
        sourceSha: prepared.sourceSha,
        sourceTree: prepared.sourceTree,
        workspaceDigest: prepared.workspaceDigest,
      }),
    ).resolves.toMatchObject({ eligible: true });
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
      resolve(sandbox.resolvePath("repository"), "microfrontends.json"),
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
        resolve(sandbox.resolvePath("repository"), "microfrontends.json"),
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
    fixtureGit(root, ["add", "README.md"]);
    fixtureGit(root, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "advance fixture",
    ]);
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

  it("keeps read-only planning independent of implementation and release layout", async () => {
    const root = fixture();
    writeFileSync(
      join(root, ".config/mise/scripts/repository/app-contract.ts"),
      "export function repositorySpecificPlanner() {}\n",
    );
    writeFileSync(
      join(root, ".config/mise/scripts/repository/app-identity.ts"),
      "export function repositorySpecificIdentity() {}\n",
    );
    writeFileSync(
      join(root, ".config/turbo/generators/config.ts"),
      "export const repositorySpecificGenerator = true;\n",
    );
    unlinkSync(join(root, ".config/turbo/generators/create-app.ts"));
    writeFileSync(
      join(root, ".github/workflows/cd.yml"),
      "jobs:\n  release:\n    runs-on: ubuntu-latest\n",
    );
    writeFileSync(
      join(root, ".config/repository-template.json"),
      '{"repositoryOwned":"future declaration"}\n',
    );
    fixtureGit(root, ["add", "--all"]);
    fixtureGit(root, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "refactor compatible repository",
    ]);
    process.env.REPOSITORY_LOCAL_ROOTS = root;

    const eligibility = await inspectSupportedRepository(root);
    const receipt = await inspectSourceReceipt("existing-repository", root);
    const sandbox = fakeSandbox();
    const workspace = await prepareSupportedSandboxWorkspace(
      root,
      receipt.sourceSha,
      receipt.eligibilityDigest,
      sandbox,
      "call-compatible-planning",
      false,
      "planning",
    );

    expect(eligibility.planningEligible).toBe(true);
    expect(eligibility.eligible).toBe(false);
    expect(eligibility.releasePolicy.eligible).toBe(false);
    expect(eligibility.compatibilityDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(receipt.eligibilityDigest).toBe(eligibility.compatibilityDigest);
    expect(workspace.sourceSha).toBe(receipt.sourceSha);
    expect(() =>
      assertRepositoryReleasePolicyAtGitSnapshot({
        sourcePath: receipt.sourcePath,
        sourceSha: receipt.sourceSha,
        sourceTree: receipt.sourceTree,
      }),
    ).toThrow("release policy required for outward effects");
    await expect(
      assertPreparedSandboxReleasePolicy({
        sandbox,
        sourceSha: workspace.sourceSha,
        sourceTree: workspace.sourceTree,
        workspaceDigest: workspace.workspaceDigest,
      }),
    ).rejects.toThrow("release policy required for outward effects");
    await expect(inspectSourceReceipt("fresh-template", root)).rejects.toThrow(
      "Source is not eligible",
    );
  });

  it("fails read-only planning on missing commands, runtime, or topology", async () => {
    const missingCommand = fixture();
    const misePath = join(missingCommand, ".config/mise/config.toml");
    writeFileSync(
      misePath,
      readFileSync(misePath, "utf8").replace(
        '[tasks."app:test"]',
        '[tasks."renamed:test"]',
      ),
    );
    commitFixture(missingCommand, "remove required test command");
    process.env.REPOSITORY_LOCAL_ROOTS = missingCommand;
    const commandResult = await inspectSupportedRepository(missingCommand);
    expect(commandResult.planningEligible).toBe(false);
    expect(commandResult.planningFailures).toContain(
      "app:test command is missing",
    );

    const unsupportedRuntime = fixture();
    writeFileSync(
      join(unsupportedRuntime, "package.json"),
      '{"name":"unsupported-runtime","private":true}\n',
    );
    commitFixture(unsupportedRuntime, "remove next runtime");
    process.env.REPOSITORY_LOCAL_ROOTS = unsupportedRuntime;
    const runtimeResult = await inspectSupportedRepository(unsupportedRuntime);
    expect(runtimeResult.planningEligible).toBe(false);
    expect(runtimeResult.planningFailures).toContain(
      "repository does not declare the Next.js runtime",
    );
    expect(runtimeResult.compatibilityDigest).not.toBe(
      commandResult.compatibilityDigest,
    );

    const invalidTopology = fixture();
    writeFileSync(join(invalidTopology, "microfrontends.json"), "[]\n");
    commitFixture(invalidTopology, "invalidate topology owner");
    process.env.REPOSITORY_LOCAL_ROOTS = invalidTopology;
    const topologyResult = await inspectSupportedRepository(invalidTopology);
    expect(topologyResult.planningEligible).toBe(false);
    expect(topologyResult.planningFailures).toContain(
      "repository topology owner is invalid",
    );
  });

  it("fails closed when the planner still declares Vite", async () => {
    const root = fixture();
    writeFileSync(
      join(root, ".config/mise/scripts/repository/app-contract.ts"),
      'const source = { runtime: "vite" };\n',
    );
    commitFixture(root, "declare unsupported planner runtime");
    process.env.REPOSITORY_LOCAL_ROOTS = root;
    const eligibility = await inspectSupportedRepository(root);
    expect(eligibility.eligible).toBe(false);
    expect(eligibility.planningEligible).toBe(true);
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
    commitFixture(root, "restore retired generator path");
    process.env.REPOSITORY_LOCAL_ROOTS = root;
    const eligibility = await inspectSupportedRepository(root);
    expect(eligibility.eligible).toBe(false);
    expect(eligibility.planningEligible).toBe(true);
    expect(eligibility.failures).toContain(
      "missing required path .config/turbo/generators/create-app.ts",
    );
  });

  it("rejects alternate release-gate declarations", async () => {
    const root = fixture();
    writeFileSync(
      join(root, ".github/workflows/cd.yml"),
      "jobs:\n  template-safety:\n    name: something else\n",
    );
    commitFixture(root, "change release gate");
    process.env.REPOSITORY_LOCAL_ROOTS = root;
    const eligibility = await inspectSupportedRepository(root);
    expect(eligibility.eligible).toBe(false);
    expect(eligibility.planningEligible).toBe(true);
    expect(eligibility.releasePolicy.eligible).toBe(false);
    expect(eligibility.failures).toContain(
      "REPOSITORY_RELEASE_ENABLED gate is not the supported CD gate",
    );
  });
});
