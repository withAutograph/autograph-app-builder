import { chmod, mkdir, mkdtemp, readFile, realpath, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createDevelopmentSnapshot,
  developmentDependencyKey,
  fingerprintDevelopmentSource,
  parseDevelopmentArguments,
} from "./local-mode";

const roots: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  const makeWritable = async (path: string) => {
    await chmod(path, 0o700).catch(() => undefined);
    for (const entry of await readdir(path, { withFileTypes: true }).catch(() => [])) {
      if (entry.isDirectory()) await makeWritable(join(path, entry.name));
      else if (!entry.isSymbolicLink()) await chmod(join(path, entry.name), 0o600).catch(() => undefined);
    }
  };
  await Promise.all(roots.map(makeWritable));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "app-builder-dev-source-")));
  roots.push(root);
  await mkdir(join(root, ".config/mise"), { recursive: true });
  await writeFile(join(root, ".config/mise/config.toml"), "[tools]\nbun = \"1.3.14\"\n");
  await writeFile(join(root, ".config/mise/mise.lock"), "mise-lock\n");
  await writeFile(join(root, "bun.lock"), "bun-lock\n");
  await writeFile(join(root, "Cargo.lock"), "cargo-lock\n");
  await writeFile(join(root, "README.md"), "committed\n");
  const { execFileSync } = await import("node:child_process");
  const git = (...args: string[]) =>
    execFileSync("/usr/bin/git", args, {
      cwd: root,
      env: { PATH: "/usr/bin:/bin", HOME: "/dev/null", LC_ALL: "C" },
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
  it("captures dirty and untracked source in an owner-only read-only Git snapshot", async () => {
    const source = await fixture();
    await writeFile(join(source, "README.md"), "dirty\n");
    await writeFile(join(source, "new-file.ts"), "export const fresh = true;\n");
    const runRoot = await realpath(await mkdtemp(join(tmpdir(), "app-builder-dev-run-")));
    roots.push(runRoot);
    await chmod(runRoot, 0o700);

    const snapshot = await createDevelopmentSnapshot({ sourceRoot: source, runRoot });

    expect(await readFile(join(snapshot.root, "README.md"), "utf8")).toBe("dirty\n");
    expect(await readFile(join(snapshot.root, "new-file.ts"), "utf8")).toContain("fresh");
    expect((await stat(snapshot.root)).mode & 0o777).toBe(0o500);
    expect((await stat(join(snapshot.root, "README.md"))).mode & 0o777).toBe(0o400);
    expect(snapshot.fingerprint).toBe(await fingerprintDevelopmentSource(source));
    expect(snapshot.commit).toMatch(/^[0-9a-f]{40}$/u);
  });

  it("changes the content fingerprint when source bytes change", async () => {
    const source = await fixture();
    const before = await fingerprintDevelopmentSource(source);
    await writeFile(join(source, "README.md"), "changed\n");
    expect(await fingerprintDevelopmentSource(source)).not.toBe(before);
  });
});

describe("development dependency key", () => {
  it("reuses code-only dependency state and refreshes on lock or platform changes", async () => {
    const source = await fixture();
    const tools = { node: "24.18.0", bun: "1.3.14", mise: "2026.8.12" };
    const first = await developmentDependencyKey({ sourceRoot: source, platform: "linux/arm64", tools });
    await writeFile(join(source, "README.md"), "ordinary source edit\n");
    expect(await developmentDependencyKey({ sourceRoot: source, platform: "linux/arm64", tools })).toBe(first);
    await writeFile(join(source, "bun.lock"), "changed lock\n");
    expect(await developmentDependencyKey({ sourceRoot: source, platform: "linux/arm64", tools })).not.toBe(first);
    expect(await developmentDependencyKey({ sourceRoot: source, platform: "linux/amd64", tools })).not.toBe(first);
  });
});

describe("development CLI", () => {
  it("requires one explicit Arrusted checkout and rejects release-shaped inputs", () => {
    expect(() => parseDevelopmentArguments([])).toThrow(/--arrusted-root/u);
    expect(() => parseDevelopmentArguments(["--arrusted-root", "/tmp/arrusted", "--endpoint", "https://example.com"])).toThrow(/unsupported/u);
    expect(parseDevelopmentArguments(["--arrusted-root", "/tmp/arrusted"])).toMatchObject({
      arrustedRoot: "/tmp/arrusted",
      nextPort: 3000,
      evePort: 2000,
    });
  });
});
