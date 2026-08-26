import { describe, expect, it } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
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
  ARRUSTED_IMAGE_TARGET_SHA,
  ARRUSTED_IMAGE_TARGET_TREE,
  assertCanonicalRoot,
  assertExactImageToolVersion,
  assertNoSecretMaterial,
  assertProofRuntimeIgnoredInventory,
  assertStandaloneGitMetadata,
  createExactImageProvenance,
  exactDigestReference,
  hashArtifact,
  ghcrLoginCommand,
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

describe("image lifecycle", () => {
  it("allows only a fixed GHCR command that reads its token from stdin", () => {
    expect(ghcrLoginCommand("withAutograph")).toEqual({
      program: "docker",
      args: [
        "login",
        "ghcr.io",
        "--username",
        "withAutograph",
        "--password-stdin",
      ],
    });
    expect(() => ghcrLoginCommand("owner/token")).toThrow("malformed");
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
