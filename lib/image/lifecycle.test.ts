import { describe, expect, it } from "vitest";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  assertGithubStateRoot,
  assertBoundGhcrPayload,
  githubConfigDigest,
  githubStateDigest,
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
  parseRemoteIndexDescriptor,
  parseRemoteIndexInspection,
  parseRemoteImageInspection,
  prepareProofRuntimeCommand,
  remoteDescriptorCommand,
  remoteImageCommand,
  remoteIndexCommand,
  remoteManifestCommand,
  sandboxProofCommand,
} from "./lifecycle.ts";
import {
  currentGhcrCredentialBinding,
  ghcrCredentialEnvironment,
  hasExactKeys,
  imageToolInvocation,
  materializeSanitizedGitTree,
  normalizedNodeModulesDigest,
  preloadImage,
  reconcileLifecycleTemps,
  withImageLifecycleTestProvenance,
  withBuildxRuntime,
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
    "Cargo.lock",
    ".config/mise/scripts/repository/app-identity.ts",
    ".config/mise/scripts/repository/app-contract.ts",
    ".config/mise/scripts/repository/app-validation.ts",
    ".config/turbo/generators/create-app.ts",
    ".config/turbo/generators/templates/app/package.json.hbs",
    ".config/mise/scripts/repository/repository-preflight.ts",
    ".config/mise/tasks/repository/exec",
  ].map((path, index) => [path, "3456789abcd"[index]!.repeat(64)]),
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

describe("image lifecycle task ownership", () => {
  it("resolves every credential-bound preload executable through mise", () => {
    const task = readFileSync(".config/mise/tasks/image/preload", "utf8");
    for (const binding of [
      'APP_BUILDER_IMAGE_GH_BIN="$(mise which gh)"',
      'APP_BUILDER_IMAGE_DOCKER_BIN="$(mise which docker)"',
      'APP_BUILDER_IMAGE_BUILDX_BIN="$(mise which docker-cli-plugin-docker-buildx)"',
      'APP_BUILDER_IMAGE_MSB_BIN="$(mise which msb)"',
    ]) {
      expect(task).toContain(binding);
    }
  });
});

describe("closed receipt key sets", () => {
  const expected = [
    "authenticationBoundary",
    "authenticationBoundaryDigest",
    "authenticationProvider",
    "identityDigest",
    "keyringReadbackTransport",
    "operatorApprovalTransport",
    "providerMutation",
    "provenanceDigest",
    "registry",
    "schema",
    "status",
    "username",
  ] as const;

  it("accepts the exact GHCR login receipt keys independent of declaration order", () => {
    const exact = Object.fromEntries(
      [...expected].reverse().map((key) => [key, true]),
    );

    expect(hasExactKeys(exact, expected)).toBe(true);
    expect(hasExactKeys({ ...exact, extra: true }, expected)).toBe(false);
    const missing = { ...exact };
    delete missing.username;
    expect(hasExactKeys(missing, expected)).toBe(false);
    const collision = { ...exact };
    delete collision.authenticationBoundary;
    delete collision.authenticationBoundaryDigest;
    collision["authenticationBoundary,authenticationBoundaryDigest"] = true;
    expect(hasExactKeys(collision, expected)).toBe(false);
  });
});

function installFakeGhBoundary(
  root: string,
  token: string,
  mutateStateDuringTokenRead = false,
  state: string = join(root, "github-cli-state"),
) {
  const bin = join(root, "bin");
  const config = join(root, "gh-config");
  const msbLog = join(root, "msb-invocations.jsonl");
  mkdirSync(bin);
  mkdirSync(config, { mode: 0o700 });
  mkdirSync(state, { mode: 0o700 });
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
  *)
    [ "\${XDG_STATE_HOME:-}" = '${state}' ] || exit 42
    /bin/mkdir -p "\$XDG_STATE_HOME/gh"
    /bin/chmod 700 "\$XDG_STATE_HOME/gh"
    printf '%s\n' 'fixture-device-id' > "\$XDG_STATE_HOME/gh/device-id"
    /bin/chmod 600 "\$XDG_STATE_HOME/gh/device-id"
    case "$*" in
      'auth status --active --hostname github.com --json hosts') printf '%s\n' '{"hosts":{"github.com":[{"active":true,"gitProtocol":"https","host":"github.com","login":"withAutograph","scopes":"repo, write:packages","state":"success","tokenSource":"keyring"}]}}' ;;
      'auth token --hostname github.com --user withAutograph') ${
        mutateStateDuringTokenRead
          ? `printf '%s\n' 'mutated-device-id' > "\$XDG_STATE_HOME/gh/device-id"; /bin/chmod 600 "\$XDG_STATE_HOME/gh/device-id"; `
          : ""
      }printf '%s\n' '${token}' ;;
      'api /user --jq .login') printf '%s\n' 'withAutograph' ;;
      'api /user/memberships/orgs/withAutograph --jq [.state,.role,.organization.login] | @tsv') printf 'active\tadmin\twithAutograph\n' ;;
      *) exit 41 ;;
    esac
    ;;
esac
`,
    { mode: 0o700 },
  );
  for (const name of ["docker", "docker-buildx"] as const)
    writeFileSync(join(bin, name), `#!/bin/sh\nprintf '${name} fixture\\n'\n`, {
      mode: 0o700,
    });
  writeFileSync(
    join(bin, "msb"),
    `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { appendFileSync } = require("node:fs");
const { join } = require("node:path");
if (process.argv.length === 3 && process.argv[2] === "--version") {
  process.stdout.write("msb 0.6.14\\n");
  process.exit(0);
}
const helper = spawnSync(
  join(process.env.DOCKER_CONFIG, "docker-credential-ghcr-bound"),
  ["get"],
  { encoding: "utf8", env: process.env, input: "ghcr.io\\n" },
);
if (helper.status !== 0) {
  process.stderr.write("credential helper failed\\n");
  process.exit(51);
}
const credential = JSON.parse(helper.stdout);
const credentialDigest = createHash("sha256")
  .update(credential.Secret)
  .digest("hex");
if (credentialDigest !== "${hashArtifact(token)}") {
  process.stderr.write("credential identity mismatch\\n");
  process.exit(52);
}
appendFileSync(
  ${JSON.stringify(msbLog)},
  JSON.stringify({
    argv: process.argv.slice(2),
    environment: process.env,
    credentialDigest,
  }) + "\\n",
);
process.stdout.write("preloaded\\n");
`,
    { mode: 0o700 },
  );
  return {
    config: realpathSync(config),
    gh: realpathSync(gh),
    state: realpathSync(state),
    bin,
    commandLog,
    msbLog,
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
    APP_BUILDER_IMAGE_MSB_BIN: realpathSync(join(fixture.bin, "msb")),
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

async function withFakeGhEnvironmentAsync(
  fixture: ReturnType<typeof installFakeGhBoundary>,
  callback: () => Promise<void>,
): Promise<void> {
  const values = {
    APP_BUILDER_GH_CONFIG_DIR: fixture.config,
    APP_BUILDER_IMAGE_GH_BIN: fixture.gh,
    APP_BUILDER_IMAGE_NODE_BIN: realpathSync(process.execPath),
    APP_BUILDER_IMAGE_DOCKER_BIN: realpathSync(join(fixture.bin, "docker")),
    APP_BUILDER_IMAGE_BUILDX_BIN: realpathSync(
      join(fixture.bin, "docker-buildx"),
    ),
    APP_BUILDER_IMAGE_MSB_BIN: realpathSync(join(fixture.bin, "msb")),
  };
  const previous = Object.fromEntries(
    Object.keys(values).map((key) => [key, process.env[key]]),
  );
  try {
    Object.assign(process.env, values);
    await callback();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function seedFakeGhState(
  fixture: ReturnType<typeof installFakeGhBoundary>,
): string {
  mkdirSync(join(fixture.state, "gh"), { mode: 0o700 });
  writeFileSync(join(fixture.state, "gh", "device-id"), "fixture-device-id\n", {
    mode: 0o600,
  });
  return githubStateDigest(fixture.state);
}

type FixtureReceipt = Readonly<{
  version: 1;
  kind: string;
  provenance: ReturnType<typeof createExactImageProvenance>;
  result: unknown;
  digest: string;
}>;

function writeFixtureReceipt(
  stateRoot: string,
  filename: string,
  kind: string,
  exact: ReturnType<typeof createExactImageProvenance>,
  result: unknown,
): FixtureReceipt {
  const unsigned = { version: 1 as const, kind, provenance: exact, result };
  const receipt = {
    ...unsigned,
    digest: hashArtifact(JSON.stringify(unsigned)),
  };
  writeFileSync(
    join(stateRoot, filename),
    `${JSON.stringify(receipt, null, 2)}\n`,
    { mode: 0o600 },
  );
  return receipt;
}

function stateArtifactText(root: string): string {
  const contents: string[] = [];
  const visit = (path: string) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const absolute = join(path, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) contents.push(readFileSync(absolute, "utf8"));
    }
  };
  visit(root);
  return contents.join("\n");
}

function installPreloadFixture(
  variant:
    | "current"
    | "missing"
    | "stale"
    | "provenance-mismatch"
    | "identity-mismatch"
    | "state-drift",
) {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), `app-builder-preload-${variant}-`)),
  );
  const providerRoot = join(root, "provider");
  const stateRoot = join(root, "state");
  const arrustedRoot = join(root, "arrusted");
  mkdirSync(providerRoot, { mode: 0o700 });
  mkdirSync(stateRoot, { mode: 0o700 });
  mkdirSync(arrustedRoot, { mode: 0o700 });
  const sentinel = "github_pat_preload_behavioral_sentinel";
  const fixture = installFakeGhBoundary(
    providerRoot,
    sentinel,
    false,
    join(stateRoot, "github-cli-state"),
  );
  seedFakeGhState(fixture);
  const exact = createExactImageProvenance({
    builderRoot: realpathSync(process.cwd()),
    stateRoot: realpathSync(stateRoot),
    observedBuilderCommit: builderCommit,
    observedBuilderTree: builderTree,
    expectedBuilderCommit: builderCommit,
    expectedBuilderTree: builderTree,
    builderStatus: "",
    builderIgnored: "",
    arrustedRoot: realpathSync(arrustedRoot),
    observedArrustedCommit: ARRUSTED_IMAGE_TARGET_SHA,
    observedArrustedTree: ARRUSTED_IMAGE_TARGET_TREE,
    arrustedStatus: "",
    arrustedIgnored: "",
    dockerfileSha256,
    expectedDockerfileSha256: dockerfileSha256,
    targetFiles,
  });
  const reference = `${exact.image.repository}@sha256:${"9".repeat(64)}`;
  const approval = {
    arrustedRoot: exact.arrusted.root,
    stateRoot: exact.builder.stateRoot,
    builderCommit: exact.builder.commit,
    builderTree: exact.builder.tree,
    dockerfileSha256: exact.dockerfile.sha256,
  };

  return {
    approval,
    exact,
    fixture,
    reference,
    root,
    sentinel,
    stateRoot,
    seedReceipts: () => {
      const binding = currentGhcrCredentialBinding(stateRoot);
      const approved = Buffer.from(sentinel);
      const approvedIdentityDigest = ghcrIdentityDigest(
        "withAutograph",
        exact.digest,
        approved,
      );
      approved.fill(0);
      const loginResult = {
        schema: "ghcr-login-v3",
        status: "credential-matched",
        registry: "ghcr.io",
        username: "withAutograph",
        authenticationProvider: "gh@2.98.0-keyring",
        operatorApprovalTransport: "one-time-stdin",
        keyringReadbackTransport: "github-cli-keyring",
        providerMutation: "none",
        authenticationBoundary: binding,
        authenticationBoundaryDigest: hashArtifact(JSON.stringify(binding)),
        identityDigest:
          variant === "identity-mismatch"
            ? "0".repeat(64)
            : approvedIdentityDigest,
        provenanceDigest:
          variant === "provenance-mismatch" ? "0".repeat(64) : exact.digest,
      };
      const login =
        variant === "missing"
          ? undefined
          : writeFixtureReceipt(
              stateRoot,
              "ghcr-login-receipt.json",
              "ghcr-login",
              exact,
              loginResult,
            );
      if (variant === "stale" && login !== undefined)
        writeFileSync(
          join(stateRoot, "ghcr-login-receipt.json"),
          `${JSON.stringify({ ...login, result: { ...loginResult, status: "stale" } }, null, 2)}\n`,
          { mode: 0o600 },
        );
      writeFixtureReceipt(stateRoot, "push-receipt.json", "image-push", exact, {
        status: "pushed",
        tag: exact.image.tag,
        localImageReceiptDigest: "7".repeat(64),
        ghcrLoginReceiptDigest:
          variant === "identity-mismatch"
            ? "8".repeat(64)
            : (login?.digest ?? "6".repeat(64)),
      });
      writeFixtureReceipt(
        stateRoot,
        "remote-image-receipt.json",
        "remote-image",
        exact,
        { reference },
      );
      if (variant === "state-drift")
        writeFileSync(
          join(fixture.state, "gh", "device-id"),
          "drifted-device-id\n",
          { mode: 0o600 },
        );
    },
  };
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
            APP_BUILDER_GH_STATE_DIR: fixture.state,
          });
          const binding = currentGhcrCredentialBinding(root);
          expect(binding).toMatchObject({
            version: 3,
            provider: {
              name: "gh",
              version: "2.98.0",
              authenticationSource: "keyring",
            },
            dockerConfig: { providerName: "ghcr-bound" },
            state: {
              environment: "XDG_STATE_HOME",
              relativePath: "github-cli-state",
              policy: "owned-0700-closed-gh-device-id-v1",
            },
          });
          expect(binding.provider.sha256).toHaveLength(64);
          expect(binding.provider.configDigest).toHaveLength(64);
          expect(binding.consumers.dockerSha256).toHaveLength(64);
          expect(binding.consumers.buildxSha256).toHaveLength(64);
          expect(() =>
            assertNoSecretMaterial({
              schema: "ghcr-login-v3",
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
          const stateDigest = seedFakeGhState(fixture);
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
                  stateDigest,
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

  it("keeps GitHub CLI mutable state out of the Builder checkout", () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "app-builder-gh-state-boundary-")),
    );
    const fixture = installFakeGhBoundary(
      root,
      "github_pat_exact_private_package_token",
    );
    const builder = join(root, "builder");
    mkdirSync(builder, { mode: 0o700 });
    execFileSync("/usr/bin/git", ["init", "--quiet", builder]);
    writeFileSync(join(builder, "tracked"), "baseline\n");
    execFileSync("/usr/bin/git", ["-C", builder, "add", "tracked"]);
    const before = execFileSync(
      "/usr/bin/git",
      ["-C", builder, "status", "--porcelain=v1", "--untracked-files=all"],
      { encoding: "utf8" },
    );
    const provenanceDigest = "9".repeat(64);
    const stateDigest = seedFakeGhState(fixture);
    const approved = Buffer.from("github_pat_exact_private_package_token");
    const identity = {
      username: "withAutograph",
      digest: ghcrIdentityDigest("withAutograph", provenanceDigest, approved),
      provenanceDigest,
      stateDigest,
    };
    approved.fill(0);
    try {
      withFakeGhEnvironment(fixture, () => {
        const result = spawnSync(
          join(root, "docker-credential-ghcr-bound"),
          ["get"],
          {
            cwd: builder,
            encoding: "utf8",
            env: {
              HOME: builder,
              NODE_ENV: "test",
              XDG_STATE_HOME: join(builder, "hostile-state"),
              ...ghcrCredentialEnvironment(root, identity),
            },
            input: "ghcr.io\n",
          },
        );
        expect(result.status, result.stderr).toBe(0);
      });
      expect(
        execFileSync(
          "/usr/bin/git",
          ["-C", builder, "status", "--porcelain=v1", "--untracked-files=all"],
          { encoding: "utf8" },
        ),
      ).toBe(before);
      expect(existsSync(join(builder, ".local"))).toBe(false);
      expect(existsSync(join(builder, "hostile-state"))).toBe(false);
      expect(
        readFileSync(".config/mise/scripts/trusted-node-launcher", "utf8"),
      ).not.toContain("APP_BUILDER_GH_STATE_DIR");
      expect(readFileSync(join(fixture.state, "gh", "device-id"), "utf8")).toBe(
        "fixture-device-id\n",
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("rejects unsafe, linked, and drifted GitHub CLI state", () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "app-builder-gh-state-safety-")),
    );
    const fixture = installFakeGhBoundary(
      root,
      "github_pat_exact_private_package_token",
    );
    try {
      withFakeGhEnvironment(fixture, () => {
        assertGithubStateRoot(fixture.state);
        const initial = currentGhcrCredentialBinding(root).state.digest;
        mkdirSync(join(fixture.state, "gh"), { mode: 0o700 });
        writeFileSync(join(fixture.state, "gh", "device-id"), "one\n", {
          mode: 0o600,
        });
        const observed = currentGhcrCredentialBinding(root).state.digest;
        expect(observed).not.toBe(initial);
        writeFileSync(join(fixture.state, "unexpected"), "drift\n", {
          mode: 0o600,
        });
        expect(() => currentGhcrCredentialBinding(root)).toThrow(
          "unexpected contents",
        );
        rmSync(join(fixture.state, "unexpected"));
        chmodSync(fixture.state, 0o755);
        expect(() => currentGhcrCredentialBinding(root)).toThrow("unsafe");
        chmodSync(fixture.state, 0o700);
        rmSync(fixture.state, { recursive: true });
        const linkedTarget = join(root, "linked-state-target");
        mkdirSync(linkedTarget, { mode: 0o700 });
        symlinkSync(linkedTarget, fixture.state);
        expect(() => currentGhcrCredentialBinding(root)).toThrow(
          "state root is invalid",
        );
      });
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("accepts only a closed active keyring status with write:packages", () => {
    const valid =
      '{"hosts":{"github.com":[{"active":true,"gitProtocol":"https","host":"github.com","login":"withAutograph","scopes":"repo, write:packages","state":"success","tokenSource":"keyring"}]}}';
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
    expect(() =>
      parseGhAuthStatus(valid.replace('"https"', '"ssh"'), "withAutograph"),
    ).toThrow("did not match");
    const extraRecord = JSON.parse(valid);
    extraRecord.hosts["github.com"][0].extra = true;
    expect(() =>
      parseGhAuthStatus(JSON.stringify(extraRecord), "withAutograph"),
    ).toThrow("did not match");
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
    const stateDigest = seedFakeGhState(fixture);
    const provenanceDigest = "b".repeat(64);
    const environment: NodeJS.ProcessEnv = {
      NODE_ENV: "test",
      APP_BUILDER_IMAGE_GH_BIN: fixture.gh,
      APP_BUILDER_GH_SHA256: hashArtifact(readFileSync(fixture.gh)),
      APP_BUILDER_GH_CONFIG_DIR: fixture.config,
      APP_BUILDER_GH_CONFIG_DIGEST: githubConfigDigest(fixture.config),
      APP_BUILDER_GH_STATE_DIR: fixture.state,
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
        {
          encoding: "utf8",
          env:
            mode === "get"
              ? { ...environment, APP_BUILDER_GH_STATE_DIGEST: stateDigest }
              : environment,
          input,
        },
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

  it("emits no credential when GitHub state changes during token read-back", () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "app-builder-ghcr-state-race-")),
    );
    const approved = "github_pat_exact_private_package_token";
    const fixture = installFakeGhBoundary(root, approved, true);
    const stateDigest = seedFakeGhState(fixture);
    const provenanceDigest = "7".repeat(64);
    const environment: NodeJS.ProcessEnv = {
      NODE_ENV: "test",
      APP_BUILDER_IMAGE_GH_BIN: fixture.gh,
      APP_BUILDER_GH_SHA256: hashArtifact(readFileSync(fixture.gh)),
      APP_BUILDER_GH_CONFIG_DIR: fixture.config,
      APP_BUILDER_GH_CONFIG_DIGEST: githubConfigDigest(fixture.config),
      APP_BUILDER_GH_STATE_DIR: fixture.state,
      APP_BUILDER_GH_STATE_DIGEST: stateDigest,
      APP_BUILDER_GHCR_USERNAME: "withAutograph",
      APP_BUILDER_GHCR_IDENTITY_DIGEST: ghcrIdentityDigest(
        "withAutograph",
        provenanceDigest,
        Buffer.from(approved),
      ),
      APP_BUILDER_GHCR_PROVENANCE_DIGEST: provenanceDigest,
    };
    try {
      const result = spawnSync(
        process.execPath,
        [
          "--experimental-strip-types",
          join(process.cwd(), "lib/image/ghcr-bound-helper.ts"),
          "get",
        ],
        { encoding: "utf8", env: environment, input: "ghcr.io\n" },
      );
      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).not.toContain(approved);
      expect(result.stderr).toContain("GitHub state drifted after approval");
      expect(
        readFileSync(fixture.commandLog, "utf8").trim().split("\n"),
      ).toEqual([
        "auth status --active --hostname github.com --json hosts",
        "auth token --hostname github.com --user withAutograph",
      ]);
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
    const stateDigest = githubStateDigest(fixture.state);
    const environment: NodeJS.ProcessEnv = {
      NODE_ENV: "test",
      APP_BUILDER_IMAGE_GH_BIN: fixture.gh,
      APP_BUILDER_GH_SHA256: hashArtifact(readFileSync(fixture.gh)),
      APP_BUILDER_GH_CONFIG_DIR: fixture.config,
      APP_BUILDER_GH_CONFIG_DIGEST: githubConfigDigest(fixture.config),
      APP_BUILDER_GH_STATE_DIR: fixture.state,
      APP_BUILDER_GHCR_USERNAME: "withAutograph",
      APP_BUILDER_GHCR_IDENTITY_DIGEST: ghcrIdentityDigest(
        "withAutograph",
        provenanceDigest,
        token,
      ),
      APP_BUILDER_GHCR_PROVENANCE_DIGEST: provenanceDigest,
      APP_BUILDER_GH_STATE_DIGEST: stateDigest,
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

  it("preloads through the public path with only the current bound GHCR identity", async () => {
    const scenario = installPreloadFixture("current");
    try {
      await withFakeGhEnvironmentAsync(scenario.fixture, async () => {
        scenario.seedReceipts();
        const receipt = await withImageLifecycleTestProvenance(
          scenario.exact,
          () => preloadImage(scenario.approval, scenario.reference),
        );
        expect(receipt.result).toEqual({
          status: "preloaded",
          reference: scenario.reference,
        });
      });

      const invocations = readFileSync(scenario.fixture.msbLog, "utf8")
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as {
              argv: string[];
              environment: Record<string, string>;
              credentialDigest: string;
            },
        );
      expect(invocations).toHaveLength(1);
      expect(invocations[0]!.argv).toEqual([
        "pull",
        scenario.reference,
        "--materialize",
        "all",
      ]);
      expect(
        Object.keys(invocations[0]!.environment)
          .filter((key) => key !== "__CF_USER_TEXT_ENCODING")
          .sort(),
      ).toEqual(
        [
          "APP_BUILDER_GH_CONFIG_DIGEST",
          "APP_BUILDER_GH_CONFIG_DIR",
          "APP_BUILDER_GH_STATE_DIGEST",
          "APP_BUILDER_GH_STATE_DIR",
          "APP_BUILDER_GHCR_IDENTITY_DIGEST",
          "APP_BUILDER_GHCR_PROVENANCE_DIGEST",
          "APP_BUILDER_GHCR_USERNAME",
          "APP_BUILDER_GH_SHA256",
          "APP_BUILDER_IMAGE_GHCR_BOUND_HELPER_MODULE",
          "APP_BUILDER_IMAGE_GH_BIN",
          "APP_BUILDER_IMAGE_NODE_BIN",
          "DOCKER_CONFIG",
          "HOME",
          "LANG",
          "NODE_ENV",
          "PATH",
        ].sort(),
      );
      expect(invocations[0]!.environment).toMatchObject({
        APP_BUILDER_GHCR_USERNAME: "withAutograph",
        APP_BUILDER_GHCR_PROVENANCE_DIGEST: scenario.exact.digest,
        APP_BUILDER_GH_STATE_DIR: scenario.fixture.state,
        DOCKER_CONFIG: scenario.stateRoot,
        NODE_ENV: "production",
        PATH: `${scenario.stateRoot}:/usr/bin:/bin`,
      });
      expect(invocations[0]!.credentialDigest).toBe(
        hashArtifact(scenario.sentinel),
      );
      expect(readFileSync(scenario.fixture.msbLog, "utf8")).not.toContain(
        scenario.sentinel,
      );
      expect(stateArtifactText(scenario.stateRoot)).not.toContain(
        scenario.sentinel,
      );
    } finally {
      rmSync(scenario.root, { force: true, recursive: true });
    }
  });

  it.each([
    ["missing", "ENOENT"],
    ["stale", "digest is invalid"],
    ["provenance-mismatch", "current credential boundary"],
    ["identity-mismatch", "current GHCR login identity"],
    ["state-drift", "current credential boundary"],
  ] as const)(
    "rejects a %s login receipt before invoking the credential provider",
    async (variant, expectedError) => {
      const scenario = installPreloadFixture(variant);
      try {
        let errorText = "";
        await withFakeGhEnvironmentAsync(scenario.fixture, async () => {
          scenario.seedReceipts();
          const providerCallsBefore = readFileSync(
            scenario.fixture.commandLog,
            "utf8",
          )
            .split("\n")
            .filter((line) => line.startsWith("auth token ")).length;
          try {
            await withImageLifecycleTestProvenance(scenario.exact, () =>
              preloadImage(scenario.approval, scenario.reference),
            );
          } catch (error) {
            errorText = error instanceof Error ? error.message : String(error);
          }
          expect(errorText).toContain(expectedError);
          expect(
            readFileSync(scenario.fixture.commandLog, "utf8")
              .split("\n")
              .filter((line) => line.startsWith("auth token ")),
          ).toHaveLength(providerCallsBefore);
        });
        expect(existsSync(scenario.fixture.msbLog)).toBe(false);
        expect(
          existsSync(join(scenario.stateRoot, "preload-receipt.json")),
        ).toBe(false);
        expect(errorText).not.toContain(scenario.sentinel);
        expect(stateArtifactText(scenario.stateRoot)).not.toContain(
          scenario.sentinel,
        );
      } finally {
        rmSync(scenario.root, { force: true, recursive: true });
      }
    },
  );

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
    const reference = `ghcr.io/withautograph/autograph-app-builder-sandbox@sha256:${"9".repeat(64)}`;
    expect(remoteIndexCommand(reference).args).toContain("--raw");
    expect(remoteManifestCommand(reference).args).toEqual([
      "imagetools",
      "inspect",
      "--raw",
      reference,
    ]);
    expect(remoteImageCommand(reference).args).toContain("{{json .Image}}");
    expect(remoteImageCommand(reference).args).toContain(reference);
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
      launcher: "trusted-node",
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
      "4cda0f925bce5a438fb1593d17b3977ab2bdbe8000a2b62b3d9183a7b3f85f73",
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
    const fixtureRoot = realpathSync(
      mkdtempSync(join(tmpdir(), "app-builder-msb-invocation-")),
    );
    const fixture = installFakeGhBoundary(fixtureRoot, "approved");
    withFakeGhEnvironment(fixture, () => {
      expect(imageToolInvocation("msb", ["--version"])).toEqual({
        program: realpathSync(process.execPath),
        args: [realpathSync(join(fixture.bin, "msb")), "--version"],
      });
      const invocation = imageToolInvocation("msb", ["--version"]);
      const invoked = spawnSync(invocation.program, [...invocation.args], {
        encoding: "utf8",
        env: {
          HOME: tmpdir(),
          LANG: "C",
          NODE_ENV: "production",
          PATH: "/usr/bin:/bin",
        },
      });
      expect(invoked.status).toBe(0);
      expect(invoked.stdout).toBe("msb 0.6.14\n");
      expect(imageToolInvocation("docker", ["version"])).toEqual({
        program: realpathSync(join(fixture.bin, "docker")),
        args: ["version"],
      });
      process.env.APP_BUILDER_IMAGE_MSB_BIN = "relative/msb";
      expect(() => imageToolInvocation("msb", ["--version"])).toThrow(
        "must be resolved",
      );
    });
    rmSync(fixtureRoot, { recursive: true, force: true });
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
    const buildx = join(root, `buildx-runtime.tmp-123-${randomUUID()}`);
    mkdirSync(buildx, { mode: 0o700 });
    mkdirSync(join(buildx, "activity"));
    writeFileSync(join(buildx, "activity", "default"), "bytes");
    reconcileLifecycleTemps(root);
    expect(() => readFileSync(receipt)).toThrow();
    expect(() => readFileSync(join(context, "tracked"))).toThrow();
    expect(existsSync(buildx)).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it("isolates and removes Buildx state on success and command failure", () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "app-builder-buildx-runtime-")),
    );
    let first = "";
    expect(
      withBuildxRuntime(root, ({ BUILDX_CONFIG }) => {
        first = BUILDX_CONFIG;
        mkdirSync(join(BUILDX_CONFIG, "instances"));
        writeFileSync(join(BUILDX_CONFIG, "instances", "default"), "bytes");
        return "complete";
      }),
    ).toBe("complete");
    expect(existsSync(first)).toBe(false);
    let failed = "";
    expect(() =>
      withBuildxRuntime(root, ({ BUILDX_CONFIG }) => {
        failed = BUILDX_CONFIG;
        writeFileSync(join(BUILDX_CONFIG, "current"), "bytes");
        throw new Error("fixture failed");
      }),
    ).toThrow("fixture failed");
    expect(existsSync(failed)).toBe(false);
    expect(readdirSync(root)).toEqual([]);
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

  it("refuses linked interrupted Buildx state instead of recovering it", () => {
    for (const fixture of [
      "root-symlink",
      "nested-symlink",
      "hardlink",
    ] as const) {
      const root = realpathSync(
        mkdtempSync(join(tmpdir(), "app-builder-buildx-unsafe-")),
      );
      const outside = join(root, "outside");
      writeFileSync(outside, "keep");
      const runtime = join(root, `buildx-runtime.tmp-123-${randomUUID()}`);
      if (fixture === "root-symlink") {
        symlinkSync(outside, runtime);
      } else {
        mkdirSync(runtime, { mode: 0o700 });
        if (fixture === "nested-symlink")
          symlinkSync(outside, join(runtime, "current"));
        else linkSync(outside, join(runtime, "current"));
      }
      expect(() => reconcileLifecycleTemps(root)).toThrow(
        "Unsafe interrupted Buildx state",
      );
      expect(readFileSync(outside, "utf8")).toBe("keep");
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("binds the exact OCI index and selected platform manifest to the local image", () => {
    const exact = provenance();
    const rootFsLayers = [`sha256:${"b".repeat(64)}`];
    const attestationDigest = `sha256:${"d".repeat(64)}`;
    const manifest = {
      config: {
        digest: `sha256:${"e".repeat(64)}`,
        mediaType: "application/vnd.oci.image.config.v1+json",
        size: 512,
      },
      layers: [
        {
          digest: `sha256:${"f".repeat(64)}`,
          mediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
          size: 1024,
        },
      ],
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      schemaVersion: 2,
    };
    const manifestRaw = JSON.stringify(manifest);
    const imageId = `sha256:${hashArtifact(manifestRaw)}`;
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
          Descriptor: {
            digest: imageId,
            mediaType: "application/vnd.oci.image.manifest.v1+json",
            platform: { architecture: "arm64", os: "linux" },
            size: Buffer.byteLength(manifestRaw),
          },
        },
      ]),
      exact,
    );
    const manifests = [
      {
        digest: imageId,
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        platform: { architecture: "arm64", os: "linux" },
        size: Buffer.byteLength(manifestRaw),
      },
      {
        annotations: {
          "vnd.docker.reference.digest": imageId,
          "vnd.docker.reference.type": "attestation-manifest",
        },
        digest: attestationDigest,
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        platform: { architecture: "unknown", os: "unknown" },
        size: 564,
      },
    ];
    const indexManifests = [...manifests].reverse();
    const indexRaw = (entries: typeof manifests) =>
      JSON.stringify({
        manifests: entries,
        mediaType: "application/vnd.oci.image.index.v1+json",
        schemaVersion: 2,
      });
    const descriptorRaw = (entries: typeof manifests) => {
      const raw = indexRaw(entries);
      return JSON.stringify({
        digest: `sha256:${hashArtifact(raw)}`,
        manifests: entries,
        mediaType: "application/vnd.oci.image.index.v1+json",
        schemaVersion: 2,
        size: Buffer.byteLength(raw),
      });
    };
    const indexDigest = `sha256:${hashArtifact(indexRaw(indexManifests))}`;
    expect(
      parseRemoteIndexDescriptor(descriptorRaw(indexManifests)).indexReference,
    ).toContain(indexDigest);
    const selection = parseRemoteIndexInspection(
      descriptorRaw(indexManifests),
      indexRaw(indexManifests),
      imageId,
    );
    const image = {
      architecture: "arm64",
      os: "linux",
      config: {
        Labels: {
          "org.opencontainers.image.revision": builderCommit,
          "org.opencontainers.image.version": "sandbox-v2",
        },
      },
      rootfs: { diff_ids: rootFsLayers },
    };
    const remote = parseRemoteImageInspection(
      manifestRaw,
      JSON.stringify(image),
      exact,
      local,
      selection,
    );
    expect(remote.reference.endsWith(`@${imageId}`)).toBe(true);
    expect(remote.indexReference.endsWith(`@${indexDigest}`)).toBe(true);
    expect(remote.attestationManifestDigest).toBe(attestationDigest);
    expect(remote.attestationPolicy).toBe("descriptor-bound-not-trusted");
    const sameLengthIndexRaw = JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.index.v1+json",
      manifests: indexManifests,
    });
    expect(sameLengthIndexRaw).toHaveLength(indexRaw(indexManifests).length);
    expect(() =>
      parseRemoteIndexInspection(
        descriptorRaw(indexManifests),
        sameLengthIndexRaw,
        imageId,
      ),
    ).toThrow("declared digest");
    expect(() =>
      parseRemoteIndexInspection(
        descriptorRaw(indexManifests),
        `${indexRaw(indexManifests)} `,
        imageId,
      ),
    ).toThrow(/exact OCI image index|declared digest/u);
    expect(() =>
      parseRemoteIndexInspection(
        descriptorRaw(manifests),
        indexRaw(manifests),
        `sha256:${"0".repeat(64)}`,
      ),
    ).toThrow("platform manifest");
    const wrongAttestation: typeof manifests = [
      manifests[0]!,
      {
        ...manifests[1]!,
        annotations: {
          "vnd.docker.reference.digest": `sha256:${"0".repeat(64)}`,
          "vnd.docker.reference.type": "attestation-manifest",
        },
      },
    ];
    expect(() =>
      parseRemoteIndexInspection(
        descriptorRaw(wrongAttestation),
        indexRaw(wrongAttestation),
        imageId,
      ),
    ).toThrow("attestation manifest");
    expect(() =>
      parseRemoteIndexInspection(
        descriptorRaw([...manifests, manifests[0]!]),
        indexRaw([...manifests, manifests[0]!]),
        imageId,
      ),
    ).toThrow("descriptor set");
    expect(() =>
      parseRemoteImageInspection(
        `${manifestRaw} `,
        JSON.stringify(image),
        exact,
        local,
        selection,
      ),
    ).toThrow(/exact OCI image manifest|declared digest/u);
    expect(() =>
      parseRemoteImageInspection(
        manifestRaw,
        JSON.stringify({
          ...image,
          config: {
            Labels: {
              ...image.config.Labels,
              "org.opencontainers.image.revision": "0".repeat(40),
            },
          },
        }),
        exact,
        local,
        selection,
      ),
    ).toThrow("provenance labels");
    expect(() =>
      parseRemoteImageInspection(
        manifestRaw,
        JSON.stringify({
          ...image,
          rootfs: { diff_ids: [`sha256:${"0".repeat(64)}`] },
        }),
        exact,
        local,
        selection,
      ),
    ).toThrow("rootfs identity");
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
