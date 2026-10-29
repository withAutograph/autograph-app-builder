/* oxlint-disable sonarjs/no-os-command-from-path, anti-slop/no-unknown-parameters, typescript/no-unsafe-assignment, typescript/no-unsafe-return, typescript/no-unsafe-member-access, typescript/no-unsafe-call, typescript/no-unsafe-argument, typescript/no-unsafe-type-assertion, eslint/require-await -- Controlled filesystem fixtures exercise the fixed server-owned program and synthesize only pinned Bun lock generation. */
import type { SandboxSession } from "eve/sandbox";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  applyCandidateCatalogProgram,
  catalogDependencyName,
  normalizeCandidateCatalogProgram,
  normalizeCandidateDependencyCatalog,
} from "./candidate-dependency-catalog";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});
const fixture = (peerVersion = "1.2.3") => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "builder-catalog-")));
  roots.push(root);
  const manifests = {
    "package.json": {
      private: true,
      workspaces: ["apps/*", "packages/*"],
      devDependencies: { "fixture-tool": "1.2.3", unchanged: "9.0.0" },
      scripts: { check: "keep this" },
    },
    "apps/example/package.json": { name: "example", devDependencies: { "fixture-tool": "1.2.3" } },
    "packages/peer/package.json": { name: "peer", dependencies: { "fixture-tool": peerVersion } },
  };
  for (const [file, value] of Object.entries(manifests)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), `${JSON.stringify(value, null, 2)}\n`);
  }
  writeFileSync(path.join(root, "bun.lock"), "original lock\n");
  mkdirSync(path.join(root, "bin"));
  // The unit fixture records the fixed package-manager invocation and generates
  // synthetic lock metadata; the standalone acceptance uses real pinned Bun.
  const mise = path.join(root, "bin/mise");
  writeFileSync(
    mise,
    `#!${process.execPath}\nconst fs=require('node:fs');fs.writeFileSync(process.env.CATALOG_COMMAND_PATH,JSON.stringify(process.argv.slice(2)));if(process.env.CATALOG_LOCK_FAIL)process.exit(7);fs.writeFileSync('bun.lock','generated lock\\n');\n`,
  );
  chmodSync(mise, 0o755);
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  execFileSync("git", ["add", "package.json", "apps", "packages", "bun.lock"], { cwd: root });
  const run = (extra: Record<string, string> = {}) =>
    spawnSync(
      process.execPath,
      ["-e", normalizeCandidateCatalogProgram, root, "example", "fixture-tool"],
      {
        cwd: root,
        encoding: "utf-8",
        env: {
          ...process.env,
          PATH: path.join(root, "bin") + path.delimiter + process.env.PATH,
          CATALOG_COMMAND_PATH: path.join(root, "lock-command.json"),
          ...extra,
        },
      },
    );
  const apply = (intent: unknown, extra: Record<string, string> = {}) => {
    const intentPath = path.join(root, "catalog-intent.json");
    writeFileSync(intentPath, JSON.stringify(intent));
    return spawnSync(process.execPath, ["-e", applyCandidateCatalogProgram, root, intentPath], {
      cwd: root,
      encoding: "utf-8",
      env: {
        ...process.env,
        PATH: path.join(root, "bin") + path.delimiter + process.env.PATH,
        ...extra,
      },
    });
  };
  const normalize = (extra: Record<string, string> = {}) => {
    const planned = run(extra);
    if (planned.status !== 0) {
      return planned;
    }
    const intent = JSON.parse(planned.stdout);
    const applied = apply(intent);
    return {
      ...applied,
      stdout:
        applied.status === 0
          ? JSON.stringify({ ...intent, ...JSON.parse(applied.stdout) })
          : applied.stdout,
    };
  };
  const read = (file: string) => JSON.parse(readFileSync(path.join(root, file), "utf-8"));
  return { root, run: normalize, plan: run, apply, read };
};

describe("candidate-bound same-version dependency catalog", () => {
  it("normalizes all declared consumers, preserves unrelated metadata, generates and stages the lock", () => {
    const f = fixture();
    const result = f.run();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const receipt = JSON.parse(result.stdout);
    expect(receipt).toMatchObject({
      dependency: "fixture-tool",
      version: "1.2.3",
      lockGenerated: true,
    });
    expect(f.read("package.json")).toMatchObject({
      catalog: { "fixture-tool": "1.2.3" },
      devDependencies: { "fixture-tool": "catalog:", unchanged: "9.0.0" },
      scripts: { check: "keep this" },
    });
    expect(f.read("apps/example/package.json").devDependencies["fixture-tool"]).toBe("catalog:");
    expect(f.read("packages/peer/package.json").dependencies["fixture-tool"]).toBe("catalog:");
    expect(f.read("lock-command.json")).toEqual([
      "exec",
      "--",
      "bun",
      "install",
      "--lockfile-only",
      "--ignore-scripts",
    ]);
    expect(receipt.files.map((file: { path: string }) => file.path).toSorted()).toEqual([
      "apps/example/package.json",
      "bun.lock",
      "package.json",
      "packages/peer/package.json",
    ]);
    expect(execFileSync("git", ["diff", "--name-only"], { cwd: f.root, encoding: "utf-8" })).toBe(
      "",
    );
    const retry = f.run();
    expect(retry.status).toBe(0);
    expect(JSON.parse(retry.stdout).files).toEqual([]);
  });
  it("rejects conflicting versions before any metadata changes", () => {
    const f = fixture("2.0.0");
    const original = readFileSync(path.join(f.root, "package.json"), "utf-8");
    const result = f.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("consumers disagree");
    expect(readFileSync(path.join(f.root, "package.json"), "utf-8")).toBe(original);
  });
  it("retains an exact metadata result when normal lock generation fails", () => {
    const f = fixture();
    const result = f.run({ CATALOG_LOCK_FAIL: "1" });
    expect(result.status).toBe(0);
    const receipt = JSON.parse(result.stdout);
    expect(receipt).toMatchObject({ lockGenerated: false, lockExitCode: 7 });
    expect(receipt.files.some((file: { path: string }) => file.path === "bun.lock")).toBe(false);
    const retry = f.run();
    expect(retry.status).toBe(0);
    expect(JSON.parse(retry.stdout).lockGenerated).toBe(true);
    expect(JSON.parse(retry.stdout).files.map((file: { path: string }) => file.path)).toEqual([
      "bun.lock",
    ]);
  });
  it("refuses symlinked lock metadata before writing manifests", () => {
    const f = fixture();
    const external = path.join(f.root, "external");
    writeFileSync(external, "must remain\n");
    rmSync(path.join(f.root, "bun.lock"));
    symlinkSync(external, path.join(f.root, "bun.lock"));
    const result = f.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Symlink");
    expect(f.read("package.json").catalog).toBeUndefined();
    expect(readFileSync(external, "utf-8")).toBe("must remain\n");
  });
  it("does not absorb existing unreviewed shared edits", () => {
    const f = fixture();
    const root = f.read("package.json");
    root.scripts.check = "different command";
    writeFileSync(path.join(f.root, "package.json"), JSON.stringify(root));
    const result = f.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("unstaged edits");
    expect(f.read("apps/example/package.json").devDependencies["fixture-tool"]).toBe("1.2.3");
  });
  it("replays an interrupted write and failed staging from exact retained bytes", () => {
    const f = fixture();
    const plan = f.plan();
    expect(plan.status).toBe(0);
    const intent = JSON.parse(plan.stdout);
    // Planning and lock generation never mutate the candidate.
    expect(f.read("package.json").catalog).toBeUndefined();
    // Simulate process loss after the first atomic metadata rename, before Git staging.
    writeFileSync(
      path.join(f.root, intent.files[0].path),
      Buffer.from(intent.files[0].after, "base64"),
    );
    // Simulate Git refusing staging; the saved intent must still be usable.
    writeFileSync(path.join(f.root, ".git/index.lock"), "held");
    expect(f.apply(intent).status).not.toBe(0);
    rmSync(path.join(f.root, ".git/index.lock"));
    expect(f.apply(intent).status).toBe(0);
    expect(f.apply(intent).status).toBe(0);
    expect(f.read("package.json").catalog).toEqual({ "fixture-tool": "1.2.3" });
    expect(readFileSync(path.join(f.root, "bun.lock"), "utf-8")).toBe("generated lock\n");
  });
  it("resumes a process killed after metadata writes before staging", () => {
    const f = fixture();
    const plan = f.plan();
    expect(plan.status).toBe(0);
    const intent = JSON.parse(plan.stdout);
    const git = path.join(f.root, "bin/git");
    writeFileSync(
      git,
      `#!${process.execPath}\nconst {spawnSync}=require('node:child_process');const args=process.argv.slice(2);if(process.env.CATALOG_KILL_STAGE && args.includes('add')){process.kill(process.ppid,'SIGKILL');process.exit(1);}const result=spawnSync('/usr/bin/git',args,{stdio:'inherit'});process.exit(result.status??1);\n`,
    );
    chmodSync(git, 0o755);
    const killed = f.apply(intent, { CATALOG_KILL_STAGE: "1" });
    expect(killed.signal).toBe("SIGKILL");
    expect(f.apply(intent).status).toBe(0);
    expect(f.read("package.json").catalog).toEqual({ "fixture-tool": "1.2.3" });
  });
  it("rejects changed metadata and unrelated staged edits while recovering", () => {
    const f = fixture();
    const planned = f.plan();
    expect(planned.status).toBe(0);
    const intent = JSON.parse(planned.stdout);
    writeFileSync(path.join(f.root, "package.json"), "unapproved");
    expect(f.apply(intent).status).not.toBe(0);
    writeFileSync(
      path.join(f.root, "package.json"),
      Buffer.from(
        intent.files.find((file: { path: string }) => file.path === "package.json").before,
        "base64",
      ),
    );
    writeFileSync(path.join(f.root, "unrelated.txt"), "unapproved");
    execFileSync("git", ["add", "unrelated.txt"], { cwd: f.root });
    expect(f.apply(intent).status).not.toBe(0);
  });
  it("applies retained intent with workspace-relative SDK file APIs", async () => {
    const f = fixture();
    const planned = f.plan();
    expect(planned.status).toBe(0);
    const intent = { ...JSON.parse(planned.stdout), diagnostic: "" };
    const filePath = (file: string) => {
      if (path.isAbsolute(file)) {
        throw new Error("SDK file paths must be relative");
      }
      return path.join(f.root, file);
    };
    // SAFETY: This filesystem adapter implements only the sandbox APIs called by the real helper.
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- Focused adapter intentionally implements only the exercised sandbox ports.
    const sandbox = {
      run: async ({ command }: { command: string }) => ({
        exitCode: 0,
        stdout: execFileSync("/bin/sh", ["-c", command], { cwd: f.root, encoding: "utf-8" }),
        stderr: "",
      }),
      writeTextFile: async ({ path: file, content }: { path: string; content: string }) => {
        writeFileSync(filePath(file), content);
      },
      removePath: async ({ path: file }: { path: string }) => {
        rmSync(filePath(file), { force: true });
      },
      spawn: async ({ command }: { command: string }) => {
        const result = spawnSync("/bin/sh", ["-c", command], {
          cwd: f.root,
          env: {
            ...process.env,
            PATH: path.dirname(process.execPath) + path.delimiter + process.env.PATH,
          },
        });
        const stream = (bytes: Uint8Array) =>
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(bytes);
              controller.close();
            },
          });
        return {
          stdout: stream(result.stdout),
          stderr: stream(result.stderr),
          wait: async () => ({ exitCode: result.status }),
        };
      },
    } as unknown as SandboxSession;
    await expect(
      normalizeCandidateDependencyCatalog({
        sandbox,
        prepared: {
          root: f.root,
          workspaceRoot: f.root,
          appId: "example",
          baseSha: "base",
          baseTree: "base",
          headSha: "head",
          headTree: "head",
          conflicts: [],
        },
        intent,
      }),
    ).resolves.toMatchObject({
      lockGenerated: true,
      receipt: { files: expect.arrayContaining([expect.objectContaining({ path: "bun.lock" })]) },
    });
  });
  it("does not accept paths or commands as package selectors", () => {
    // oxlint-disable-next-line sonarjs/publicly-writable-directories -- Malicious public selectors must be rejected, including absolute paths.
    for (const name of ["../package.json", "a;echo bad", "@scope/../bad", "/tmp/other"]) {
      expect(catalogDependencyName.safeParse(name).success).toBe(false);
    }
    expect(catalogDependencyName.parse("@scope/tool")).toBe("@scope/tool");
  });
});
