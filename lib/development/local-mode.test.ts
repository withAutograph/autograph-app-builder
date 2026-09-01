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
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DEVELOPMENT_DEPENDENCY_BOOTSTRAP_VERSION,
  createDevelopmentSnapshot,
  developmentDependencyKey,
  fingerprintDevelopmentSource,
  parseDevelopmentArguments,
  waitForDevelopmentSourceChange,
} from "./local-mode";

const roots: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  const makeWritable = async (path: string) => {
    await chmod(path, 0o700).catch(() => undefined);
    for (const entry of await readdir(path, { withFileTypes: true }).catch(
      () => [],
    )) {
      if (entry.isDirectory()) await makeWritable(join(path, entry.name));
      else if (!entry.isSymbolicLink())
        await chmod(join(path, entry.name), 0o600).catch(() => undefined);
    }
  };
  await Promise.all(roots.map(makeWritable));
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "app-builder-dev-source-")),
  );
  roots.push(root);
  await mkdir(join(root, ".config/mise"), { recursive: true });
  await writeFile(
    join(root, ".config/mise/config.toml"),
    '[tools]\nbun = "1.3.14"\n',
  );
  await writeFile(join(root, ".config/mise/mise.lock"), "mise-lock\n");
  await writeFile(join(root, "bun.lock"), "bun-lock\n");
  await writeFile(join(root, "Cargo.lock"), "cargo-lock\n");
  await writeFile(join(root, "README.md"), "committed\n");
  const { execFileSync } = await import("node:child_process");
  const git = (...args: string[]) =>
    execFileSync("/usr/bin/git", args, {
      cwd: root,
      env: {
        PATH: "/usr/bin:/bin",
        HOME: "/dev/null",
        LC_ALL: "C",
        NODE_ENV: "test",
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
  it("captures dirty and untracked source in an owner-writable Git snapshot", async () => {
    const source = await fixture();
    await writeFile(join(source, "README.md"), "dirty\n");
    await writeFile(
      join(source, "new-file.ts"),
      "export const fresh = true;\n",
    );
    const runRoot = await realpath(
      await mkdtemp(join(tmpdir(), "app-builder-dev-run-")),
    );
    roots.push(runRoot);
    await chmod(runRoot, 0o700);

    const snapshot = await createDevelopmentSnapshot({
      sourceRoot: source,
      runRoot,
    });

    expect(await readFile(join(snapshot.root, "README.md"), "utf8")).toBe(
      "dirty\n",
    );
    expect(
      await readFile(join(snapshot.root, "new-file.ts"), "utf8"),
    ).toContain("fresh");
    expect((await stat(snapshot.root)).mode & 0o777).toBe(0o700);
    expect((await stat(join(snapshot.root, "README.md"))).mode & 0o777).toBe(
      0o600,
    );
    expect(snapshot.fingerprint).toBe(
      await fingerprintDevelopmentSource(source),
    );
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
    const firstRunRoot = await realpath(
      await mkdtemp(join(tmpdir(), "app-builder-dev-refresh-")),
    );
    const secondRunRoot = await realpath(
      await mkdtemp(join(tmpdir(), "app-builder-dev-refresh-")),
    );
    roots.push(firstRunRoot, secondRunRoot);
    await chmod(firstRunRoot, 0o700);
    await chmod(secondRunRoot, 0o700);
    const first = await createDevelopmentSnapshot({
      sourceRoot: source,
      runRoot: firstRunRoot,
    });
    await writeFile(join(source, "README.md"), "changed after first plan\n");
    const second = await createDevelopmentSnapshot({
      sourceRoot: source,
      runRoot: secondRunRoot,
    });

    expect(second.fingerprint).not.toBe(first.fingerprint);
    expect(await readFile(join(second.root, "README.md"), "utf8")).toBe(
      "changed after first plan\n",
    );
  });

  it("rejects a tracked file whose parent was replaced by an escaping symlink", async () => {
    const source = await fixture();
    const outside = await realpath(
      await mkdtemp(join(tmpdir(), "app-builder-dev-outside-")),
    );
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
    await expect(fingerprintDevelopmentSource(source)).rejects.toThrow(
      "ancestor was unsafe",
    );
  });

  it("invalidates an active run after a source change and closes on abort", async () => {
    const source = await fixture();
    const expectedFingerprint = await fingerprintDevelopmentSource(source);
    const changed = waitForDevelopmentSourceChange({
      sourceRoot: source,
      expectedFingerprint,
      debounceMs: 5,
      auditMs: 50,
    });
    await writeFile(join(source, "README.md"), "changed during run\n");
    await expect(changed).resolves.toBe(true);

    const controller = new AbortController();
    const stopped = waitForDevelopmentSourceChange({
      sourceRoot: source,
      expectedFingerprint: await fingerprintDevelopmentSource(source),
      signal: controller.signal,
      debounceMs: 5,
      auditMs: 50,
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
      node: "24.18.0",
      bun: "1.3.14",
      mise: "2026.8.12",
      rust: "1.97.1",
    };
    const first = await developmentDependencyKey({
      sourceRoot: source,
      platform: "linux/arm64",
      tools,
    });
    await writeFile(join(source, "README.md"), "ordinary source edit\n");
    expect(
      await developmentDependencyKey({
        sourceRoot: source,
        platform: "linux/arm64",
        tools,
      }),
    ).toBe(first);
    await writeFile(join(source, "bun.lock"), "changed lock\n");
    expect(
      await developmentDependencyKey({
        sourceRoot: source,
        platform: "linux/arm64",
        tools,
      }),
    ).not.toBe(first);
    expect(
      await developmentDependencyKey({
        sourceRoot: source,
        platform: "linux/amd64",
        tools,
      }),
    ).not.toBe(first);
    expect(
      await developmentDependencyKey({
        sourceRoot: source,
        platform: "linux/arm64",
        tools: { ...tools, rust: "1.97.2" },
      }),
    ).not.toBe(first);
  });
});

describe("development CLI", () => {
  it("requires one explicit Arrusted checkout and rejects release-shaped inputs", () => {
    expect(() => parseDevelopmentArguments([])).toThrow(/--arrusted-root/u);
    expect(() =>
      parseDevelopmentArguments([
        "--arrusted-root",
        "/tmp/arrusted",
        "--endpoint",
        "https://example.com",
      ]),
    ).toThrow(/unsupported/u);
    expect(
      parseDevelopmentArguments(["--arrusted-root", "/tmp/arrusted"]),
    ).toMatchObject({
      arrustedRoot: "/tmp/arrusted",
      nextPort: 3000,
      evePort: 2000,
    });
  });
});
