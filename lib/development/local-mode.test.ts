import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import pathModule from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { runSequentially } from "../async-sequential";

import {
  DEVELOPMENT_DEPENDENCY_BOOTSTRAP_VERSION,
  createDevelopmentSnapshot,
  developmentDependencyKey,
  developmentNextBundlerArguments,
  fingerprintDevelopmentSource,
  parseDevelopmentArguments,
  waitForDevelopmentSourceChange,
} from "./local-mode";

const { join } = pathModule;
const roots: string[] = [];

afterEach(async () => {
  const { rm: removePath } = await import("node:fs/promises");
  // Keep filesystem fixtures scoped to this local-mode test.
  // oxlint-disable-next-line unicorn/consistent-function-scoping
  const makeWritable = async (path: string) => {
    // oxlint-disable-next-line github/no-then -- Preserve the existing rejection handling and settlement behavior.
    await chmod(path, 0o700).catch(() => {});
    await runSequentially(
      // oxlint-disable-next-line github/no-then -- Preserve the existing rejection handling and settlement behavior.
      await readdir(path, { withFileTypes: true }).catch(() => []),
      async (entry) => {
        if (entry.isDirectory()) {
          await makeWritable(join(path, entry.name));
        } else if (!entry.isSymbolicLink()) {
          // oxlint-disable-next-line github/no-then -- Preserve the existing rejection handling and settlement behavior.
          await chmod(join(path, entry.name), 0o600).catch(() => {});
        }
      },
    );
  };
  await Promise.all(roots.map(makeWritable));
  await Promise.all(
    // oxlint-disable-next-line typescript/promise-function-async -- Preserve this test double's existing promise and synchronous behavior.
    roots.splice(0).map((root) => removePath(root, { force: true, recursive: true })),
  );
});

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "app-builder-dev-source-")));
  roots.push(root);
  await mkdir(join(root, ".config/mise"), { recursive: true });
  await writeFile(join(root, ".config/mise/config.toml"), '[tools]\nbun = "1.3.14"\n');
  await writeFile(join(root, ".config/mise/mise.lock"), "mise-lock\n");
  await writeFile(join(root, "bun.lock"), "bun-lock\n");
  await writeFile(join(root, "Cargo.lock"), "cargo-lock\n");
  await writeFile(join(root, "README.md"), "committed\n");
  const { execFileSync } = await import("node:child_process");
  const git = (...args: string[]) =>
    execFileSync("/usr/bin/git", args, {
      cwd: root,
      env: {
        HOME: "/dev/null",
        LC_ALL: "C",
        NODE_ENV: "test",
        PATH: "/usr/bin:/bin",
      },
    });
  git("init", "-q");
  git("add", ".");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.com",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "fixture",
  );
  return root;
}

describe("development source snapshots", () => {
  it("accepts an explicit endpoint-only launch without changing the plugin-install default", () => {
    expect(
      // oxlint-disable-next-line sonarjs/publicly-writable-directories -- Fixture path exercises local development argument parsing.
      parseDevelopmentArguments(["--arrusted-root", "/tmp/arrusted"]).installPlugin,
    ).toBeUndefined();
    expect(
      // oxlint-disable-next-line sonarjs/publicly-writable-directories -- Fixture path exercises local development argument parsing.
      parseDevelopmentArguments(["--arrusted-root", "/tmp/arrusted", "--install-plugin", "false"])
        .installPlugin,
    ).toBe(false);
    expect(
      // oxlint-disable-next-line sonarjs/publicly-writable-directories -- Fixture path exercises local development argument parsing.
      parseDevelopmentArguments(["--arrusted-root", "/tmp/arrusted", "--install-plugin", "true"])
        .installPlugin,
    ).toBe(true);
    expect(() =>
      // oxlint-disable-next-line sonarjs/publicly-writable-directories -- Fixture path exercises local development argument parsing.
      parseDevelopmentArguments(["--arrusted-root", "/tmp/arrusted", "--install-plugin", "yes"]),
    ).toThrow(/--install-plugin/u);
  });

  it("accepts an explicit endpoint-only launch without changing the plugin-install default", () => {
    expect(
      // oxlint-disable-next-line sonarjs/publicly-writable-directories -- Fixture path exercises local development argument parsing.
      parseDevelopmentArguments(["--arrusted-root", "/tmp/arrusted"]).installPlugin,
    ).toBeUndefined();
    expect(
      // oxlint-disable-next-line sonarjs/publicly-writable-directories -- Fixture path exercises local development argument parsing.
      parseDevelopmentArguments(["--arrusted-root", "/tmp/arrusted", "--install-plugin", "false"])
        .installPlugin,
    ).toBe(false);
    expect(
      // oxlint-disable-next-line sonarjs/publicly-writable-directories -- Fixture path exercises local development argument parsing.
      parseDevelopmentArguments(["--arrusted-root", "/tmp/arrusted", "--install-plugin", "true"])
        .installPlugin,
    ).toBe(true);
    expect(() =>
      // oxlint-disable-next-line sonarjs/publicly-writable-directories -- Fixture path exercises local development argument parsing.
      parseDevelopmentArguments(["--arrusted-root", "/tmp/arrusted", "--install-plugin", "yes"]),
    ).toThrow(/--install-plugin/u);
  });

  it("skips uninitialized gitlinks and snapshots live initialized submodule files", async () => {
    const source = await fixture();
    const { execFileSync } = await import("node:child_process");
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("/usr/bin/git", args, { cwd, encoding: "utf-8" });
    const head = git(source, "rev-parse", "HEAD").trim();
    const submodule = join(source, "plugin");
    git(source, "update-index", "--add", "--cacheinfo", `160000,${head},plugin`);
    await mkdir(submodule);
    const empty = await fingerprintDevelopmentSource(source);
    await writeFile(join(submodule, "not-initialized.txt"), "not a checkout");
    expect(await fingerprintDevelopmentSource(source)).toBe(empty);

    git(submodule, "init", "-q");
    await writeFile(join(submodule, ".gitignore"), "ignored.txt\n");
    await writeFile(join(submodule, "tracked.txt"), "original");
    git(submodule, "add", ".gitignore", "tracked.txt");
    await writeFile(join(submodule, "tracked.txt"), "dirty");
    await writeFile(join(submodule, "ignored.txt"), "ignored");
    const runRoot = await realpath(await mkdtemp(join(tmpdir(), "app-builder-dev-submodule-")));
    roots.push(runRoot);
    await chmod(runRoot, 0o700);
    const snapshot = await createDevelopmentSnapshot({
      runRoot,
      sourceRoot: source,
    });
    expect(await readFile(join(snapshot.root, "plugin/tracked.txt"), "utf-8")).toBe("dirty");
    expect(await readFile(join(snapshot.root, "plugin/not-initialized.txt"), "utf-8")).toBe(
      "not a checkout",
    );
    await expect(stat(join(snapshot.root, "plugin/ignored.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(snapshot.fingerprint).not.toBe(empty);
  });

  it("retains already captured tracked-but-ignored source in the actual snapshot Git tree", async () => {
    const source = await fixture();
    await writeFile(
      join(source, ".gitignore"),
      ".config/mise/config.toml\nignored-secret.env\nnode_modules/\n",
    );
    await writeFile(join(source, ".config/mise/config.toml"), '[tools]\nbun = "dirty-original"\n');
    await writeFile(join(source, "ignored-secret.env"), "private synthetic value");
    await mkdir(join(source, "node_modules"));
    await writeFile(join(source, "node_modules/ignored.js"), "not source");
    const runRoot = await realpath(await mkdtemp(join(tmpdir(), "app-builder-ignored-tracked-")));
    roots.push(runRoot);
    await chmod(runRoot, 0o700);
    const snapshot = await createDevelopmentSnapshot({ sourceRoot: source, runRoot });
    const { execFileSync } = await import("node:child_process");
    const actual = execFileSync(
      "/usr/bin/git",
      ["-C", snapshot.root, "show", `${snapshot.commit}:.config/mise/config.toml`],
      { encoding: "utf-8", env: { HOME: "/dev/null", PATH: "/usr/bin:/bin", NODE_ENV: "test" } },
    );
    expect(actual).toBe(await readFile(join(source, ".config/mise/config.toml"), "utf-8"));
    expect(snapshot.fingerprint).toBe(await fingerprintDevelopmentSource(snapshot.root));
    await expect(stat(join(snapshot.root, "ignored-secret.env"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(stat(join(snapshot.root, "node_modules/ignored.js"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("captures dirty and untracked source in an owner-writable Git snapshot", async () => {
    const source = await fixture();
    await writeFile(join(source, "README.md"), "dirty\n");
    await writeFile(join(source, "new-file.ts"), "export const fresh = true;\n");
    const runRoot = await realpath(await mkdtemp(join(tmpdir(), "app-builder-dev-run-")));
    roots.push(runRoot);
    await chmod(runRoot, 0o700);

    const snapshot = await createDevelopmentSnapshot({
      runRoot,
      sourceRoot: source,
    });

    expect(await readFile(join(snapshot.root, "README.md"), "utf-8")).toBe("dirty\n");
    expect(await readFile(join(snapshot.root, "new-file.ts"), "utf-8")).toContain("fresh");
    const snapshotRootStats = await stat(snapshot.root);
    const readmeStats = await stat(join(snapshot.root, "README.md"));
    // oxlint-disable-next-line eslint/no-bitwise -- Intentional permission-mode bitmask.
    expect(snapshotRootStats.mode & 0o777).toBe(0o700);
    // oxlint-disable-next-line eslint/no-bitwise -- Intentional permission-mode bitmask.
    expect(readmeStats.mode & 0o777).toBe(0o600);
    expect(snapshot.fingerprint).toBe(await fingerprintDevelopmentSource(source));
    expect(snapshot.commit).toMatch(/^[0-9a-f]{40}$/u);
  });

  it("changes the content fingerprint when source bytes change", async () => {
    const source = await fixture();
    const before = await fingerprintDevelopmentSource(source);
    await writeFile(join(source, "README.md"), "changed\n");
    expect(await fingerprintDevelopmentSource(source)).not.toBe(before);
  });

  it("refreshes the reviewed snapshot after a live Arrusted edit", async () => {
    const source = await fixture();
    const firstRunRoot = await realpath(await mkdtemp(join(tmpdir(), "app-builder-dev-refresh-")));
    const secondRunRoot = await realpath(await mkdtemp(join(tmpdir(), "app-builder-dev-refresh-")));
    roots.push(firstRunRoot, secondRunRoot);
    await chmod(firstRunRoot, 0o700);
    await chmod(secondRunRoot, 0o700);
    const first = await createDevelopmentSnapshot({
      runRoot: firstRunRoot,
      sourceRoot: source,
    });
    await writeFile(join(source, "README.md"), "changed after first plan\n");
    const second = await createDevelopmentSnapshot({
      runRoot: secondRunRoot,
      sourceRoot: source,
    });

    expect(second.fingerprint).not.toBe(first.fingerprint);
    expect(await readFile(join(second.root, "README.md"), "utf-8")).toBe(
      "changed after first plan\n",
    );
  });

  it("rejects a tracked file whose parent was replaced by an escaping symlink", async () => {
    const source = await fixture();
    const outside = await realpath(await mkdtemp(join(tmpdir(), "app-builder-dev-outside-")));
    roots.push(outside);
    await mkdir(join(source, "tracked"));
    await writeFile(join(source, "tracked/secret.txt"), "inside\n");
    const { execFileSync } = await import("node:child_process");
    execFileSync("/usr/bin/git", ["add", "tracked/secret.txt"], {
      cwd: source,
    });
    await rm(join(source, "tracked"), { recursive: true });
    await writeFile(join(outside, "secret.txt"), "outside\n");
    await symlink(outside, join(source, "tracked"));
    await expect(fingerprintDevelopmentSource(source)).rejects.toThrow("ancestor was unsafe");
  });

  it("invalidates an active run after a source change and closes on abort", async () => {
    const source = await fixture();
    const expectedFingerprint = await fingerprintDevelopmentSource(source);
    const changed = waitForDevelopmentSourceChange({
      auditMs: 50,
      debounceMs: 5,
      expectedFingerprint,
      sourceRoot: source,
    });
    await writeFile(join(source, "README.md"), "changed during run\n");
    await expect(changed).resolves.toBe(true);

    const controller = new AbortController();
    const stopped = waitForDevelopmentSourceChange({
      auditMs: 50,
      debounceMs: 5,
      expectedFingerprint: await fingerprintDevelopmentSource(source),
      signal: controller.signal,
      sourceRoot: source,
    });
    controller.abort();
    await expect(stopped).resolves.toBe(false);
  });
});

describe("development dependency key", () => {
  it("reuses code-only dependency state and refreshes on lock or platform changes", async () => {
    expect(DEVELOPMENT_DEPENDENCY_BOOTSTRAP_VERSION).toBe(2);
    const source = await fixture();
    const tools = {
      bun: "1.3.14",
      mise: "2026.9.12",
      node: "24.18.0",
      rust: "1.97.1",
    };
    const first = await developmentDependencyKey({
      platform: "linux/arm64",
      sourceRoot: source,
      tools,
    });
    await writeFile(join(source, "README.md"), "ordinary source edit\n");
    expect(
      await developmentDependencyKey({
        platform: "linux/arm64",
        sourceRoot: source,
        tools,
      }),
    ).toBe(first);
    await writeFile(join(source, "bun.lock"), "changed lock\n");
    expect(
      await developmentDependencyKey({
        platform: "linux/arm64",
        sourceRoot: source,
        tools,
      }),
    ).not.toBe(first);
    expect(
      await developmentDependencyKey({
        platform: "linux/amd64",
        sourceRoot: source,
        tools,
      }),
    ).not.toBe(first);
    expect(
      await developmentDependencyKey({
        platform: "linux/arm64",
        sourceRoot: source,
        tools: { ...tools, rust: "1.97.2" },
      }),
    ).not.toBe(first);
  });
});

describe("development CLI", () => {
  it("keeps the default bundler and passes an explicit supported selection to Next", () => {
    // oxlint-disable-next-line sonarjs/publicly-writable-directories -- Fixture path exercises local development argument parsing.
    const defaults = parseDevelopmentArguments(["--arrusted-root", "/tmp/arrusted"]);
    expect(developmentNextBundlerArguments(defaults)).toEqual([]);
    for (const nextBundler of ["turbopack", "webpack"] as const) {
      const selected = parseDevelopmentArguments([
        "--arrusted-root",
        // oxlint-disable-next-line sonarjs/publicly-writable-directories -- Fixture path exercises local development argument parsing.
        "/tmp/arrusted",
        "--next-bundler",
        nextBundler,
      ]);
      expect(selected.nextBundler).toBe(nextBundler);
      expect(developmentNextBundlerArguments(selected)).toEqual([`--${nextBundler}`]);
    }
    expect(() =>
      // oxlint-disable-next-line sonarjs/publicly-writable-directories -- Fixture path exercises local development argument parsing.
      parseDevelopmentArguments(["--arrusted-root", "/tmp/arrusted", "--next-bundler", "unknown"]),
    ).toThrow("--next-bundler must be turbopack or webpack.");
  });
  it("requires one explicit Arrusted checkout and rejects release-shaped inputs", () => {
    expect(() => parseDevelopmentArguments([])).toThrow(/--arrusted-root/u);
    expect(() =>
      parseDevelopmentArguments([
        "--arrusted-root",
        // oxlint-disable-next-line sonarjs/publicly-writable-directories -- Fixture path exercises local development argument parsing.
        "/tmp/arrusted",
        "--endpoint",
        "https://example.com",
      ]),
    ).toThrow(/unsupported/u);
    // oxlint-disable-next-line sonarjs/publicly-writable-directories -- Fixture path exercises local development argument parsing.
    expect(parseDevelopmentArguments(["--arrusted-root", "/tmp/arrusted"])).toMatchObject({
      // oxlint-disable-next-line sonarjs/publicly-writable-directories -- Fixture path exercises local development argument parsing.
      arrustedRoot: "/tmp/arrusted",
      evePort: 2000,
      nextPort: 3000,
    });
  });
});

it("opts into emulated web without changing default development", () => {
  expect(
    // oxlint-disable-next-line sonarjs/publicly-writable-directories -- Fixture path exercises local development argument parsing.
    parseDevelopmentArguments(["--arrusted-root", "/tmp/arrusted"]).emulatedWeb,
  ).toBeUndefined();
  expect(
    parseDevelopmentArguments([
      "--arrusted-root",
      // oxlint-disable-next-line sonarjs/publicly-writable-directories -- Fixture path exercises local development argument parsing.
      "/tmp/arrusted",
      "--emulated-web",
      "true",
      "--web-ca",
      // oxlint-disable-next-line sonarjs/publicly-writable-directories -- Fixture path exercises local development argument parsing.
      "/tmp/ca.pem",
    ]),
    // oxlint-disable-next-line sonarjs/publicly-writable-directories -- Fixture path exercises local development argument parsing.
  ).toMatchObject({ emulatedWeb: true, webCa: "/tmp/ca.pem" });
  expect(() =>
    // oxlint-disable-next-line sonarjs/publicly-writable-directories -- Fixture path exercises local development argument parsing.
    parseDevelopmentArguments(["--arrusted-root", "/tmp/arrusted", "--emulated-web", "yes"]),
  ).toThrow("true or false");
});

it("selects an existing hosted MCP resource through the native connector", () => {
  expect(
    parseDevelopmentArguments([
      "--arrusted-root",
      // oxlint-disable-next-line sonarjs/publicly-writable-directories -- Fixture path exercises local development argument parsing.
      "/tmp/arrusted",
      "--hosted-session-resource",
      "https://builder.example.test/mcp",
    ]).hostedSessionResource,
  ).toBe("https://builder.example.test/mcp");
  for (const value of [
    "http://builder.example.test/mcp",
    "https://private@builder.example.test/mcp",
    "https://builder.example.test/mcp?token=private",
  ]) {
    expect(() =>
      parseDevelopmentArguments([
        "--arrusted-root",
        // oxlint-disable-next-line sonarjs/publicly-writable-directories -- Fixture path exercises local development argument parsing.
        "/tmp/arrusted",
        "--hosted-session-resource",
        value,
      ]),
    ).toThrow();
  }
});

it("selects an existing native client by an explicit absolute path", () => {
  expect(
    parseDevelopmentArguments([
      "--arrusted-root",
      // oxlint-disable-next-line sonarjs/publicly-writable-directories -- Fixture path exercises local development argument parsing.
      "/tmp/arrusted",
      "--hosted-session-resource",
      "https://builder.example.test/mcp",
      "--hosted-session-codex-bin",
      "/tools/codex",
    ]).hostedSessionCodexBin,
  ).toBe("/tools/codex");
  expect(() =>
    parseDevelopmentArguments([
      "--arrusted-root",
      // oxlint-disable-next-line sonarjs/publicly-writable-directories -- Fixture path exercises local development argument parsing.
      "/tmp/arrusted",
      "--hosted-session-codex-bin",
      "relative-codex",
    ]),
  ).toThrow();
});
