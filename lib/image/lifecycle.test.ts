import { describe, expect, it } from "vitest";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  assertBoundGhcrPayload,
  githubConfigDigest,
  ghcrIdentityDigest,
  parseGhAuthStatus,
  readBoundedInput,
} from "./ghcr-bound-helper.ts";

import {
  ARRUSTED_IMAGE_TARGET_SHA,
  ARRUSTED_IMAGE_TARGET_TREE,
  assertCanonicalRoot,
  assertExactImageToolVersion,
  assertGhcrUsername,
  assertNoSecretMaterial,
  assertProofRuntimeIgnoredInventory,
  assertStandaloneGitMetadata,
  createExactImageProvenance,
  exactDigestReference,
  hashArtifact,
  imageBuildCommand,
  imagePreloadCommand,
  imageToolVersionCommand,
  inspectProofRuntimeCommand,
  localImageInspectionCommand,
  parseLocalImageInspection,
  parseRemoteImageInspection,
  prepareProofRuntimeCommand,
  remoteDescriptorCommand,
  remoteImageCommand,
  remoteManifestCommand,
  sandboxProofCommand,
} from "./lifecycle.ts";
import {
  currentGhcrCredentialBinding,
  ghcrCredentialEnvironment,
  materializeSanitizedGitTree,
  normalizedNodeModulesDigest,
  reconcileLifecycleTemps,
  withLifecycleLock,
} from "./node-lifecycle.ts";

const builderCommit = "1".repeat(40);
const builderTree = "2".repeat(40);
const dockerfileSha256 = "3".repeat(64);
const targetFiles = Object.fromEntries(
  [
    ".config/mise/config.toml",
    ".config/mise/mise.lock",
    "bun.lock",
    ".config/mise/scripts/repository/app-identity.ts",
    ".config/mise/scripts/repository/app-contract.ts",
    ".config/mise/scripts/repository/repository-preflight.ts",
    ".config/mise/tasks/repository/exec",
  ].map((path, index) => [path, "456789a"[index]!.repeat(64)]),
);

const provenance = () =>
  createExactImageProvenance({
    builderRoot: "/tmp/exact-builder",
    stateRoot: "/tmp/exact-image-state",
    observedBuilderCommit: builderCommit,
    observedBuilderTree: builderTree,
    expectedBuilderCommit: builderCommit,
    expectedBuilderTree: builderTree,
    builderStatus: "",
    builderIgnored: "",
    arrustedRoot: "/tmp/exact-arrusted",
    observedArrustedCommit: ARRUSTED_IMAGE_TARGET_SHA,
    observedArrustedTree: ARRUSTED_IMAGE_TARGET_TREE,
    arrustedStatus: "",
    arrustedIgnored: "",
    dockerfileSha256,
    expectedDockerfileSha256: dockerfileSha256,
    targetFiles,
  });

function installFakeGhBoundary(root: string, token: string) {
  const bin = join(root, "bin");
  const config = join(root, "gh-config");
  mkdirSync(bin);
  mkdirSync(config, { mode: 0o700 });
  writeFileSync(join(config, "config.yml"), "git_protocol: ssh\n", {
    mode: 0o600,
  });
  writeFileSync(
    join(config, "hosts.yml"),
    "github.com:\n  user: withAutograph\n",
    { mode: 0o600 },
  );
  const gh = join(bin, "gh");
  const commandLog = join(root, "gh-commands.log");
  writeFileSync(
    gh,
    `#!/bin/sh
set -eu
[ -z "\${GH_TOKEN:-}" ] && [ -z "\${GITHUB_TOKEN:-}" ]
printf '%s\n' "$*" >> '${commandLog}'
case "$*" in
  version) printf 'gh version 2.98.0 (fixture)\n' ;;
  'auth status --active --hostname github.com --json hosts') printf '%s\n' '{"hosts":{"github.com":[{"active":true,"host":"github.com","login":"withAutograph","scopes":"repo, write:packages","state":"success","tokenSource":"keyring"}]}}' ;;
  'auth token --hostname github.com --user withAutograph') printf '%s\n' '${token}' ;;
  'api /user --jq .login') printf '%s\n' 'withAutograph' ;;
  'api /user/memberships/orgs/withAutograph --jq [.state,.role,.organization.login] | @tsv') printf 'active\tadmin\twithAutograph\n' ;;
  *) exit 41 ;;
esac
`,
    { mode: 0o700 },
  );
  for (const name of ["docker", "docker-buildx"] as const)
    writeFileSync(join(bin, name), `#!/bin/sh\nprintf '${name} fixture\\n'\n`, {
      mode: 0o700,
    });
  return {
    config: realpathSync(config),
    gh: realpathSync(gh),
    bin,
    commandLog,
  };
}

function withFakeGhEnvironment(
  fixture: ReturnType<typeof installFakeGhBoundary>,
  callback: () => void,
) {
  const values = {
    APP_BUILDER_GH_CONFIG_DIR: fixture.config,
    APP_BUILDER_IMAGE_GH_BIN: fixture.gh,
    APP_BUILDER_IMAGE_NODE_BIN: realpathSync(process.execPath),
    APP_BUILDER_IMAGE_DOCKER_BIN: realpathSync(join(fixture.bin, "docker")),
    APP_BUILDER_IMAGE_BUILDX_BIN: realpathSync(
      join(fixture.bin, "docker-buildx"),
    ),
  };
  const previous = Object.fromEntries(
    Object.keys(values).map((key) => [key, process.env[key]]),
  );
  try {
    Object.assign(process.env, values);
    callback();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("image lifecycle", () => {
  it("binds the pinned GitHub CLI, keyring configuration, and image consumers", () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "app-builder-ghcr-helper-")),
    );
    const fixture = installFakeGhBoundary(
      root,
      "github_pat_exact_private_package_token",
    );
    try {
      withFakeGhEnvironment(fixture, () => {
        const oldHome = process.env.HOME;
        process.env.HOME = root;
        mkdirSync(join(root, ".config"));
        symlinkSync(fixture.config, join(root, ".config/gh"));
        try {
          expect(ghcrCredentialEnvironment(root)).toMatchObject({
            PATH: `${root}:/usr/bin:/bin`,
            DOCKER_CONFIG: root,
            APP_BUILDER_IMAGE_GH_BIN: fixture.gh,
          });
          const binding = currentGhcrCredentialBinding(root);
          expect(binding).toMatchObject({
            version: 2,
            provider: {
              name: "gh",
              version: "2.98.0",
              authenticationSource: "keyring",
            },
            dockerConfig: { providerName: "ghcr-bound" },
          });
          expect(binding.provider.sha256).toHaveLength(64);
          expect(binding.provider.configDigest).toHaveLength(64);
          expect(binding.consumers.dockerSha256).toHaveLength(64);
          expect(binding.consumers.buildxSha256).toHaveLength(64);
          expect(() =>
            assertNoSecretMaterial({
              schema: "ghcr-login-v2",
              status: "credential-matched",
              registry: "ghcr.io",
              username: "withAutograph",
              authenticationProvider: "gh@2.98.0-keyring",
              operatorApprovalTransport: "one-time-stdin",
              keyringReadbackTransport: "github-cli-keyring",
              providerMutation: "none",
              authenticationBoundary: binding,
              authenticationBoundaryDigest: "e".repeat(64),
              identityDigest: "f".repeat(64),
              provenanceDigest: "a".repeat(64),
            }),
          ).not.toThrow();
          const provenanceDigest = "c".repeat(64);
          const approved = Buffer.from(
            "github_pat_exact_private_package_token",
          );
          const helperResult = spawnSync(
            join(root, "docker-credential-ghcr-bound"),
            ["get"],
            {
              encoding: "utf8",
              env: {
                NODE_ENV: "test",
                ...ghcrCredentialEnvironment(root, {
                  username: "withAutograph",
                  digest: ghcrIdentityDigest(
                    "withAutograph",
                    provenanceDigest,
                    approved,
                  ),
                  provenanceDigest,
                }),
              },
              input: "ghcr.io\n",
            },
          );
          approved.fill(0);
          expect(helperResult.status, helperResult.stderr).toBe(0);
          expect(JSON.parse(helperResult.stdout)).toMatchObject({
            ServerURL: "https://ghcr.io",
            Username: "withAutograph",
          });
          writeFileSync(
            join(root, "config.json"),
            '{"credsStore":"ambient"}\n',
            { mode: 0o600 },
          );
          expect(() => ghcrCredentialEnvironment(root)).toThrow(
            "closed schema",
          );
        } finally {
          if (oldHome === undefined) delete process.env.HOME;
          else process.env.HOME = oldHome;
        }
      });
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("accepts only a closed active keyring status with write:packages", () => {
    const valid =
      '{"hosts":{"github.com":[{"active":true,"host":"github.com","login":"withAutograph","scopes":"repo, write:packages","state":"success","tokenSource":"keyring"}]}}';
    expect(parseGhAuthStatus(valid, "withAutograph").tokenSource).toBe(
      "keyring",
    );
    expect(() =>
      parseGhAuthStatus(valid.replace("keyring", "env"), "withAutograph"),
    ).toThrow("did not match");
    expect(() =>
      parseGhAuthStatus(
        valid.replace("write:packages", "read:packages"),
        "withAutograph",
      ),
    ).toThrow("package-write");
    expect(() =>
      parseGhAuthStatus(
        JSON.stringify({ ...JSON.parse(valid), extra: true }),
        "withAutograph",
      ),
    ).toThrow("malformed");
    expect(() => assertGhcrUsername("owner/token")).toThrow("malformed");
  });

  it("rejects plaintext GitHub credentials from the bound keyring configuration", () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "app-builder-gh-config-")),
    );
    const fixture = installFakeGhBoundary(
      root,
      "github_pat_exact_private_package_token",
    );
    try {
      expect(githubConfigDigest(fixture.config)).toHaveLength(64);
      writeFileSync(
        join(fixture.config, "hosts.yml"),
        "github.com:\n  user: withAutograph\n  oauth_token: forbidden\n",
        { mode: 0o600 },
      );
      expect(() => githubConfigDigest(fixture.config)).toThrow(
        "Plaintext GitHub credentials",
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("binds the stdin token to the exact helper credential without recording it", () => {
    const token = Buffer.from("github_pat_exact_private_package_token");
    const credential = JSON.stringify({
      ServerURL: "https://ghcr.io",
      Username: "withAutograph",
      Secret: token.toString("utf8"),
    });
    const provenanceDigest = "a".repeat(64);
    const identityDigest = ghcrIdentityDigest(
      "withAutograph",
      provenanceDigest,
      token,
    );
    expect(() =>
      assertBoundGhcrPayload(
        credential,
        "withAutograph",
        provenanceDigest,
        identityDigest,
      ),
    ).not.toThrow();
    expect(() =>
      assertBoundGhcrPayload(
        credential,
        "withAutograph",
        provenanceDigest,
        ghcrIdentityDigest(
          "withAutograph",
          provenanceDigest,
          Buffer.from("github_pat_different_private_token"),
        ),
      ),
    ).toThrow("drifted after approval");
    expect(() =>
      assertBoundGhcrPayload(
        credential,
        "another-user",
        provenanceDigest,
        identityDigest,
      ),
    ).toThrow("identity did not match");
    expect(() =>
      assertBoundGhcrPayload(
        JSON.stringify({ ...JSON.parse(credential), Extra: true }),
        "withAutograph",
        provenanceDigest,
        identityDigest,
      ),
    ).toThrow("identity did not match");
  });

  it("rejects credential input beyond the closed bound", () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "app-builder-ghcr-input-")),
    );
    const path = join(root, "oversized-input");
    writeFileSync(path, "x".repeat(4097), { mode: 0o600 });
    const descriptor = openSync(path, "r");
    try {
      expect(() => readBoundedInput(descriptor, 4096)).toThrow(
        "exceeded the closed size limit",
      );
    } finally {
      closeSync(descriptor);
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("checks keyring drift inside Docker's actual get helper without ambient credentials", () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "app-builder-ghcr-bound-helper-")),
    );
    const approved = "github_pat_exact_private_package_token";
    const fixture = installFakeGhBoundary(root, approved);
    const provenanceDigest = "b".repeat(64);
    const environment: NodeJS.ProcessEnv = {
      NODE_ENV: "test",
      APP_BUILDER_IMAGE_GH_BIN: fixture.gh,
      APP_BUILDER_GH_SHA256: hashArtifact(readFileSync(fixture.gh)),
      APP_BUILDER_GH_CONFIG_DIR: fixture.config,
      APP_BUILDER_GH_CONFIG_DIGEST: githubConfigDigest(fixture.config),
      APP_BUILDER_GHCR_USERNAME: "withAutograph",
      APP_BUILDER_GHCR_IDENTITY_DIGEST: ghcrIdentityDigest(
        "withAutograph",
        provenanceDigest,
        Buffer.from(approved),
      ),
      APP_BUILDER_GHCR_PROVENANCE_DIGEST: provenanceDigest,
    };
    const verifierModule = join(
      process.cwd(),
      "lib/image/ghcr-bound-helper.ts",
    );
    const invoke = (input: string, mode: "get" | "verify-login" = "get") =>
      spawnSync(
        process.execPath,
        ["--experimental-strip-types", verifierModule, mode],
        { encoding: "utf8", env: environment, input },
      );
    try {
      const oversized = invoke("x".repeat(257));
      expect(oversized.status).not.toBe(0);

      const accepted = invoke("ghcr.io\n");
      expect(accepted.status).toBe(0);
      expect(accepted.stdout).toContain(approved);
      expect(accepted.stderr).not.toContain(approved);

      const verified = invoke(`${approved}\n`, "verify-login");
      expect(verified.status, verified.stderr).toBe(0);
      expect(verified.stdout).not.toContain(approved);
      expect(JSON.parse(verified.stdout)).toEqual({
        Username: "withAutograph",
        identityDigest: environment.APP_BUILDER_GHCR_IDENTITY_DIGEST,
        provenanceDigest,
      });
      expect(
        readFileSync(fixture.commandLog, "utf8").trim().split("\n"),
      ).toEqual([
        "auth status --active --hostname github.com --json hosts",
        "auth token --hostname github.com --user withAutograph",
        "auth status --active --hostname github.com --json hosts",
        "auth token --hostname github.com --user withAutograph",
        "api /user --jq .login",
        "api /user/memberships/orgs/withAutograph --jq [.state,.role,.organization.login] | @tsv",
      ]);
      const rejected = invoke(
        "github_pat_different_private_package_token\n",
        "verify-login",
      );
      expect(rejected.status).not.toBe(0);
      expect(rejected.stdout).toBe("");
      expect(rejected.stderr).not.toContain(approved);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("keeps the helper and provider descendants in one externally killable process group", async () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "app-builder-ghcr-process-group-")),
    );
    const fixture = installFakeGhBoundary(
      root,
      "github_pat_exact_private_package_token",
    );
    const descendant = join(root, "descendant.pid");
    writeFileSync(
      fixture.gh,
      `#!/bin/sh
/bin/sleep 30 &
printf '%s\n' "$!" > '${descendant}'
wait
`,
      { mode: 0o700 },
    );
    const provenanceDigest = "d".repeat(64);
    const token = Buffer.from("github_pat_exact_private_package_token");
    const environment: NodeJS.ProcessEnv = {
      NODE_ENV: "test",
      APP_BUILDER_IMAGE_GH_BIN: fixture.gh,
      APP_BUILDER_GH_SHA256: hashArtifact(readFileSync(fixture.gh)),
      APP_BUILDER_GH_CONFIG_DIR: fixture.config,
      APP_BUILDER_GH_CONFIG_DIGEST: githubConfigDigest(fixture.config),
      APP_BUILDER_GHCR_USERNAME: "withAutograph",
      APP_BUILDER_GHCR_IDENTITY_DIGEST: ghcrIdentityDigest(
        "withAutograph",
        provenanceDigest,
        token,
      ),
      APP_BUILDER_GHCR_PROVENANCE_DIGEST: provenanceDigest,
    };
    const child = spawn(
      process.execPath,
      [
        "--experimental-strip-types",
        join(process.cwd(), "lib/image/ghcr-bound-helper.ts"),
        "get",
      ],
      { detached: true, env: environment, stdio: ["pipe", "ignore", "ignore"] },
    );
    child.stdin.end("ghcr.io\n");
    try {
      for (
        let attempts = 0;
        attempts < 100 && !existsSync(descendant);
        attempts += 1
      )
        await new Promise((resolveWait) => setTimeout(resolveWait, 10));
      expect(existsSync(descendant)).toBe(true);
      process.kill(-child.pid!, "SIGKILL");
      await new Promise<void>((resolveClose) =>
        child.once("close", () => resolveClose()),
      );
      const descendantPid = Number(readFileSync(descendant, "utf8").trim());
      for (let attempts = 0; attempts < 100; attempts += 1) {
        try {
          process.kill(descendantPid, 0);
          await new Promise((resolveWait) => setTimeout(resolveWait, 10));
        } catch {
          break;
        }
      }
      expect(() => process.kill(descendantPid, 0)).toThrow();
    } finally {
      token.fill(0);
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {}
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("checks an exact login receipt before any stdin or provider operation", () => {
    const source = readFileSync("lib/image/node-lifecycle.ts", "utf8");
    const start = source.indexOf("async function loginGhcrUnlocked");
    const end = source.indexOf("function inspectRemoteImageUnlocked", start);
    const body = source.slice(start, end);
    expect(body.indexOf("optionalReceipt(")).toBeGreaterThan(0);
    expect(body.indexOf("readGhcrTokenFromStdin()")).toBeGreaterThan(
      body.indexOf("optionalReceipt("),
    );
    expect(body.indexOf("requireCurrentGhcrLogin(provenance)")).toBeLessThan(
      body.indexOf("readGhcrTokenFromStdin()"),
    );
  });

  it("sends no Builder workspace files through the default build context", () => {
    expect(readFileSync(".dockerignore", "utf8")).toBe("**\n");
    const dockerfile = readFileSync(
      "containers/eve-sandbox/Dockerfile",
      "utf8",
    );
    for (const line of dockerfile
      .split("\n")
      .filter((line) => line.startsWith("COPY ")))
      expect(line).toContain("--from=");
  });

  it("constructs exact standalone build, inspection, preload, and proof commands", () => {
    const exact = provenance();
    expect(imageBuildCommand(exact, "/tmp/sanitized-arrusted")).toEqual({
      program: "docker-buildx",
      args: [
        "build",
        "--platform",
        "linux/arm64",
        "--build-context",
        "arrusted-target=/tmp/sanitized-arrusted",
        "--build-arg",
        `APP_BUILDER_REVISION=${builderCommit}`,
        "--file",
        "containers/eve-sandbox/Dockerfile",
        "--tag",
        exact.image.tag,
        "--load",
        "/tmp/exact-builder",
      ],
    });
    expect(localImageInspectionCommand(exact).args).toContain("linux/arm64");
    expect(remoteDescriptorCommand(exact).program).toBe("docker-buildx");
    expect(remoteManifestCommand(exact).args).toContain("--raw");
    expect(remoteImageCommand(exact).args).toContain("{{json .Image}}");
    const reference = `ghcr.io/withautograph/autograph-app-builder-sandbox@sha256:${"9".repeat(64)}`;
    expect(imagePreloadCommand(reference)).toEqual({
      program: "msb",
      args: ["pull", reference, "--materialize", "all"],
    });
    expect(prepareProofRuntimeCommand()).toEqual({
      program: "pnpm",
      args: ["install", "--force", "--frozen-lockfile", "--ignore-scripts"],
    });
    expect(inspectProofRuntimeCommand()).toEqual({
      program: "pnpm",
      args: ["list", "--depth", "Infinity", "--json"],
    });
    expect(sandboxProofCommand(reference, "/tmp/exact-arrusted")).toEqual({
      program: "node",
      args: [
        "--import",
        "tsx",
        "scripts/run-eve-eval.mts",
        "--gate-a-profile",
        "sandbox",
        "--gate-a-image",
        reference,
        "--gate-a-source-root",
        "/tmp/exact-arrusted",
        "sandbox-identity-planning",
        "--strict",
        "--skip-report",
      ],
    });
  });

  it("pins and validates exact mise-owned tool versions", () => {
    const miseConfig = readFileSync(".config/mise/config.toml", "utf8");
    const miseLock = readFileSync(".config/mise/mise.lock", "utf8");
    for (const expected of [
      '"aqua:docker/buildx" = "0.33.0"',
      'docker-cli = "29.4.0"',
      '"npm:microsandbox" = "0.6.14"',
    ])
      expect(miseConfig).toContain(expected);
    for (const expected of [
      '[[tools."aqua:docker/buildx"]]',
      "[[tools.docker-cli]]",
      '[[tools."npm:microsandbox"]]',
    ])
      expect(miseLock).toContain(expected);
    const dockerfileDigest = hashArtifact(
      readFileSync("containers/eve-sandbox/Dockerfile"),
    );
    expect(dockerfileDigest).toBe(
      "0ee3864919f22017ca84addddd86fbbc5c26e92396cd31cc576e09280918bc76",
    );
    expect(
      readFileSync("containers/eve-sandbox/README.md", "utf8"),
    ).not.toContain(
      "4334f7eac9260580ad0c07c8f03b466060062215333752e8d4d625f024401267",
    );
    expect(imageToolVersionCommand("docker-buildx")).toEqual({
      program: "docker-buildx",
      args: ["version"],
    });
    expect(() =>
      assertExactImageToolVersion(
        "docker-buildx",
        "github.com/docker/buildx v0.33.0 f7897e",
      ),
    ).not.toThrow();
    expect(() =>
      assertExactImageToolVersion("docker", "Docker version 29.3.0, build old"),
    ).toThrow("does not match");
    expect(() =>
      assertExactImageToolVersion("msb", "Microsandbox CLI v0.6.14"),
    ).not.toThrow();
    expect(() => assertExactImageToolVersion("pnpm", "11.7.0")).not.toThrow();
  });

  it("refuses approval, status, standalone-checkout, and symlink drift", () => {
    expect(() =>
      createExactImageProvenance({
        ...{
          builderRoot: "/tmp/exact-builder",
          stateRoot: "/tmp/exact-image-state",
          observedBuilderCommit: builderCommit,
          observedBuilderTree: builderTree,
          expectedBuilderCommit: "0".repeat(40),
          expectedBuilderTree: builderTree,
          builderStatus: "",
          builderIgnored: "",
          arrustedRoot: "/tmp/exact-arrusted",
          observedArrustedCommit: ARRUSTED_IMAGE_TARGET_SHA,
          observedArrustedTree: ARRUSTED_IMAGE_TARGET_TREE,
          arrustedStatus: "",
          arrustedIgnored: "",
          dockerfileSha256,
          expectedDockerfileSha256: dockerfileSha256,
          targetFiles,
        },
      }),
    ).toThrow("Builder commit changed");
    expect(() =>
      createExactImageProvenance({
        ...{
          builderRoot: "/tmp/exact-builder",
          stateRoot: "/tmp/exact-image-state",
          observedBuilderCommit: builderCommit,
          observedBuilderTree: builderTree,
          expectedBuilderCommit: builderCommit,
          expectedBuilderTree: builderTree,
          builderStatus: "?? drift",
          builderIgnored: "",
          arrustedRoot: "/tmp/exact-arrusted",
          observedArrustedCommit: ARRUSTED_IMAGE_TARGET_SHA,
          observedArrustedTree: ARRUSTED_IMAGE_TARGET_TREE,
          arrustedStatus: "",
          arrustedIgnored: "",
          dockerfileSha256,
          expectedDockerfileSha256: dockerfileSha256,
          targetFiles,
        },
      }),
    ).toThrow("dirty paths");
    expect(() =>
      createExactImageProvenance({
        builderRoot: "/tmp/exact-builder",
        stateRoot: "/tmp/exact-image-state",
        observedBuilderCommit: builderCommit,
        observedBuilderTree: builderTree,
        expectedBuilderCommit: builderCommit,
        expectedBuilderTree: builderTree,
        builderStatus: "",
        builderIgnored: "node_modules/eve/index.js",
        arrustedRoot: "/tmp/exact-arrusted",
        observedArrustedCommit: ARRUSTED_IMAGE_TARGET_SHA,
        observedArrustedTree: ARRUSTED_IMAGE_TARGET_TREE,
        arrustedStatus: "",
        arrustedIgnored: "",
        dockerfileSha256,
        expectedDockerfileSha256: dockerfileSha256,
        targetFiles,
      }),
    ).toThrow("ignored-file inventory");
    expect(() => assertStandaloneGitMetadata(false, "Builder")).toThrow(
      "standalone checkout",
    );
    expect(() =>
      assertCanonicalRoot("/tmp/link", "/private/tmp/real", "Source"),
    ).toThrow("no-link path");
    expect(() =>
      assertProofRuntimeIgnoredInventory("!! node_modules/"),
    ).not.toThrow();
    expect(() =>
      assertProofRuntimeIgnoredInventory("!! .env\n!! node_modules/"),
    ).toThrow("only the exact Builder node_modules");
  });

  it("binds proof-runtime file bytes and refuses escaping symlinks", () => {
    const root = mkdtempSync(join(tmpdir(), "app-builder-proof-runtime-"));
    const nodeModules = join(root, "node_modules");
    mkdirSync(join(nodeModules, "package"), { recursive: true });
    const file = join(nodeModules, "package", "index.js");
    writeFileSync(file, "one\n");
    const first = normalizedNodeModulesDigest(nodeModules);
    writeFileSync(file, "two\n");
    expect(normalizedNodeModulesDigest(nodeModules)).not.toBe(first);
    symlinkSync("../../../outside", join(nodeModules, "escape"));
    expect(() => normalizedNodeModulesDigest(nodeModules)).toThrow(
      "escapes node_modules",
    );
    rmSync(root, { recursive: true, force: true });
  });

  it("materializes only tracked Git objects and excludes credential-bearing metadata", () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "app-builder-sanitized-git-")),
    );
    const source = join(root, "source");
    const destination = join(root, "sanitized");
    mkdirSync(source, { mode: 0o700 });
    execFileSync("git", ["init", "--quiet", source]);
    execFileSync("git", ["-C", source, "config", "user.name", "Fixture"]);
    execFileSync("git", [
      "-C",
      source,
      "config",
      "user.email",
      "fixture@example.com",
    ]);
    execFileSync("git", [
      "-C",
      source,
      "config",
      "credential.helper",
      "super-secret-helper",
    ]);
    writeFileSync(join(source, "tracked.txt"), "tracked bytes\n");
    mkdirSync(join(source, "nested", "deeper"), { recursive: true });
    writeFileSync(
      join(source, "nested", "deeper", "payload.txt"),
      "nested bytes\n",
    );
    writeFileSync(join(source, "nested", "run.sh"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(source, "nested", "run.sh"), 0o755);
    execFileSync("git", ["-C", source, "add", "tracked.txt", "nested"]);
    execFileSync("git", [
      "-C",
      source,
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    ]);
    const commit = execFileSync("git", ["-C", source, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    const tree = execFileSync(
      "git",
      ["-C", source, "rev-parse", "HEAD^{tree}"],
      { encoding: "utf8" },
    ).trim();
    const context = materializeSanitizedGitTree(
      source,
      destination,
      commit,
      tree,
    );
    const orderedPaths = [
      "nested/deeper/payload.txt",
      "nested/run.sh",
      "tracked.txt",
    ] as const;
    const modes = ["100644", "100755", "100644"] as const;
    const expectedRecords = orderedPaths.map((path, index) => {
      const objectId = execFileSync(
        "git",
        ["-C", source, "hash-object", "--", path],
        { encoding: "utf8" },
      ).trim();
      return `${modes[index]}\0${objectId}\0${path}`;
    });
    const expectedEntriesDigest = hashArtifact(expectedRecords.join("\n"));
    expect(context).toEqual({
      root: destination,
      entriesDigest: expectedEntriesDigest,
      entryCount: orderedPaths.length,
    });
    expect(readFileSync(join(destination, "tracked.txt"), "utf8")).toBe(
      "tracked bytes\n",
    );
    expect(
      readFileSync(
        join(destination, "nested", "deeper", "payload.txt"),
        "utf8",
      ),
    ).toBe("nested bytes\n");
    expect(readFileSync(join(destination, "nested", "run.sh"), "utf8")).toBe(
      "#!/bin/sh\nexit 0\n",
    );
    expect(lstatSync(join(destination, "nested", "run.sh")).mode & 0o777).toBe(
      0o755,
    );
    expect(() => readFileSync(join(destination, ".git", "config"))).toThrow();
    const manifestBytes = readFileSync(
      join(destination, ".app-builder-source-manifest.json"),
      "utf8",
    );
    expect(JSON.parse(manifestBytes)).toEqual({
      version: 1,
      source: { commit, tree },
      entriesDigest: expectedEntriesDigest,
      entryCount: orderedPaths.length,
    });
    expect(manifestBytes).not.toContain("super-secret-helper");
    expect(JSON.stringify(context)).not.toContain("super-secret-helper");
    rmSync(root, { recursive: true, force: true });
  });

  it("serializes concurrent lifecycle operations for one state root", async () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "app-builder-lifecycle-lock-")),
    );
    let enter!: () => void;
    const entered = new Promise<void>((resolveEntered) => {
      enter = resolveEntered;
    });
    let release!: () => void;
    const held = new Promise<void>((resolveRelease) => {
      release = resolveRelease;
    });
    let dispatches = 0;
    const first = withLifecycleLock(root, async () => {
      dispatches += 1;
      enter();
      await held;
    });
    await entered;
    await expect(
      withLifecycleLock(root, () => {
        dispatches += 1;
      }),
    ).rejects.toThrow("exclusive external-operation lock");
    expect(dispatches).toBe(1);
    release();
    await first;
    await expect(withLifecycleLock(root, () => "recovered")).resolves.toBe(
      "recovered",
    );
    rmSync(root, { recursive: true, force: true });
  });

  it("reconciles exact owned receipt and context temporaries", () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "app-builder-lifecycle-reconcile-")),
    );
    const receipt = join(root, `build-receipt.json.tmp-123-${randomUUID()}`);
    writeFileSync(receipt, "partial", { mode: 0o600 });
    const context = join(root, `arrusted-context.tmp-123-${randomUUID()}`);
    mkdirSync(context, { mode: 0o700 });
    writeFileSync(join(context, "tracked"), "bytes");
    reconcileLifecycleTemps(root);
    expect(() => readFileSync(receipt)).toThrow();
    expect(() => readFileSync(join(context, "tracked"))).toThrow();
    rmSync(root, { recursive: true, force: true });
  });

  it("recovers a SIGKILL-released lock and exact interrupted temp receipt", async () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "app-builder-lifecycle-crash-")),
    );
    const moduleUrl = pathToFileURL(
      join(process.cwd(), "lib/image/node-lifecycle.ts"),
    ).href;
    const code = `import { randomUUID } from "node:crypto"; import { openSync, closeSync } from "node:fs"; import { join } from "node:path"; import { withLifecycleLock } from ${JSON.stringify(moduleUrl)}; await withLifecycleLock(${JSON.stringify(root)}, async () => { const path=join(${JSON.stringify(root)}, \`source-receipt.json.tmp-\${process.pid}-\${randomUUID()}\`); closeSync(openSync(path, "wx", 0o600)); console.log(path); setInterval(() => {}, 1_000); await new Promise(() => {}); });`;
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", "--input-type=module", "--eval", code],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    const interruptedPath = await new Promise<string>((resolvePath, reject) => {
      let output = "";
      const timeout = setTimeout(
        () =>
          reject(new Error("Timed out waiting for lifecycle crash fixture.")),
        3_000,
      );
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        output += chunk;
        const line = output.split("\n")[0];
        if (line !== "") {
          clearTimeout(timeout);
          resolvePath(line);
        }
      });
    });
    child.kill("SIGKILL");
    await new Promise((resolveExit) => child.once("exit", resolveExit));
    expect(readFileSync(interruptedPath)).toHaveLength(0);
    await withLifecycleLock(root, () => reconcileLifecycleTemps(root));
    expect(() => readFileSync(interruptedPath)).toThrow();
    rmSync(root, { recursive: true, force: true });
  });

  it("refuses unsafe temp artifacts instead of cleaning through links", () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "app-builder-lifecycle-temp-")),
    );
    const outside = join(root, "outside");
    writeFileSync(outside, "keep");
    symlinkSync(
      outside,
      join(root, `source-receipt.json.tmp-1-${randomUUID()}`),
    );
    expect(() => reconcileLifecycleTemps(root)).toThrow(
      "Unsafe interrupted receipt artifact",
    );
    expect(readFileSync(outside, "utf8")).toBe("keep");
    rmSync(root, { recursive: true, force: true });
  });

  it("binds remote config and rootfs identity to the exact local image", () => {
    const exact = provenance();
    const imageId = `sha256:${"a".repeat(64)}`;
    const rootFsLayers = [`sha256:${"b".repeat(64)}`];
    const local = parseLocalImageInspection(
      JSON.stringify([
        {
          Id: imageId,
          Architecture: "arm64",
          Os: "linux",
          RepoTags: [exact.image.tag],
          Config: {
            Labels: {
              "org.opencontainers.image.revision": builderCommit,
              "org.opencontainers.image.version": "sandbox-v2",
            },
          },
          RootFS: { Layers: rootFsLayers },
        },
      ]),
      exact,
    );
    const remote = parseRemoteImageInspection(
      JSON.stringify({ digest: `sha256:${"c".repeat(64)}` }),
      JSON.stringify({
        config: { digest: imageId },
        layers: [{ digest: `sha256:${"d".repeat(64)}` }],
      }),
      JSON.stringify({
        architecture: "arm64",
        os: "linux",
        config: {
          Labels: {
            "org.opencontainers.image.revision": builderCommit,
            "org.opencontainers.image.version": "sandbox-v2",
          },
        },
        rootfs: { diff_ids: rootFsLayers },
      }),
      exact,
      local,
    );
    expect(remote.reference.endsWith(`@sha256:${"c".repeat(64)}`)).toBe(true);
    expect(() =>
      parseRemoteImageInspection(
        JSON.stringify({ digest: `sha256:${"c".repeat(64)}` }),
        JSON.stringify({
          config: { digest: `sha256:${"e".repeat(64)}` },
          layers: [{ digest: `sha256:${"d".repeat(64)}` }],
        }),
        JSON.stringify({
          architecture: "arm64",
          os: "linux",
          config: {
            Labels: {
              "org.opencontainers.image.revision": builderCommit,
              "org.opencontainers.image.version": "sandbox-v2",
            },
          },
          rootfs: { diff_ids: rootFsLayers },
        }),
        exact,
        local,
      ),
    ).toThrow("config digest");
  });

  it("rejects mutable preload references and secret-like receipt material", () => {
    expect(() => exactDigestReference(provenance().image.tag)).toThrow(
      "exact digest",
    );
    expect(() => assertNoSecretMaterial({ authorization: "redacted" })).toThrow(
      "forbidden secret field",
    );
    expect(JSON.stringify(provenance())).not.toMatch(
      /(authorization|credential|password|secret|token)/iu,
    );
  });
});
