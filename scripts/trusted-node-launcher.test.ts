import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "..");
const launcher = resolve(
  repositoryRoot,
  ".config/mise/scripts/trusted-node-launcher",
);
const pinnedNode = process.execPath.includes("/mise/installs/")
  ? process.execPath
  : spawnSync("mise", ["which", "node"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    }).stdout.trim();

function taskFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    return statSync(path).isDirectory() ? taskFiles(path) : [path];
  });
}

describe("trusted Node launcher", () => {
  it("rejects data-URL NODE_OPTIONS before the first Node process", () => {
    const result = spawnSync(
      launcher,
      [pinnedNode, "-e", "process.stdout.write('node-ran')"],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_OPTIONS:
            "--import=data:text/javascript,process.stdout.write('injected')",
        },
      },
    );
    expect(result.status).toBe(78);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("refusing ambient NODE_OPTIONS");
  });

  it("accepts only a clean mise-pinned Node or pnpm executable", () => {
    const cleanEnvironment = { ...process.env };
    delete cleanEnvironment.NODE_OPTIONS;
    const accepted = spawnSync(
      launcher,
      [pinnedNode, "-e", "process.stdout.write('ok')"],
      { cwd: repositoryRoot, encoding: "utf8", env: cleanEnvironment },
    );
    expect(accepted.status, accepted.stderr).toBe(0);
    expect(accepted.stdout).toBe("ok");
    const rejected = spawnSync(launcher, ["/bin/echo", "unsafe"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: cleanEnvironment,
    });
    expect(rejected.status).toBe(78);
    expect(rejected.stdout).toBe("");
    const fakeRoot = mkdtempSync(join(tmpdir(), "fake-mise-root-"));
    const fakeNode = join(fakeRoot, "mise/installs/node/24.18.0/bin/node");
    mkdirSync(resolve(fakeNode, ".."), { recursive: true });
    writeFileSync(fakeNode, "#!/bin/sh\necho fake\n");
    chmodSync(fakeNode, 0o755);
    const fake = spawnSync(launcher, [fakeNode], {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: cleanEnvironment,
    });
    expect(fake.status).toBe(78);
    expect(fake.stdout).toBe("");
  });

  it("does not trust a forged public symbol and matching environment", () => {
    const cleanEnvironment: NodeJS.ProcessEnv = {
      ...process.env,
      APP_BUILDER_TEST_MODEL: "1",
      APP_BUILDER_TEST_CAPABILITY_ID: "a".repeat(64),
    };
    delete cleanEnvironment.NODE_OPTIONS;
    const source = `
      const id = "${"a".repeat(64)}";
      process[Symbol.for("withAutograph.autograph-app-builder.test-capability.v1")] = Object.freeze({ version: 1, id, capabilities: Object.freeze(["mock-model"]) });
      const { hasTestCapability } = await import("./lib/testing/test-capability.ts");
      process.stdout.write(String(hasTestCapability("mock-model")));
    `;
    const result = spawnSync(
      launcher,
      [pinnedNode, "--import", "tsx", "--input-type=module", "-e", source],
      { cwd: repositoryRoot, encoding: "utf8", env: cleanEnvironment },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("false");
  });

  it("rejects a trusted wrapper name supplied only as a dummy argv token", () => {
    const cleanEnvironment = { ...process.env };
    delete cleanEnvironment.NODE_OPTIONS;
    const wrapperLibrary = pathToFileURL(
      resolve(repositoryRoot, "scripts/run-with-test-capability.mts"),
    ).href;
    const vitest = resolve(repositoryRoot, "node_modules/vitest/vitest.mjs");
    const source = `
      const { runWithTestCapability } = await import(${JSON.stringify(wrapperLibrary)});
      await runWithTestCapability({ profile: "vitest", command: process.execPath, args: [${JSON.stringify(vitest)}], capabilities: ["mock-model", "simulated-target", "simulated-publication"] });
    `;
    const result = spawnSync(
      launcher,
      [
        pinnedNode,
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        source,
        "scripts/run-vitest.mts",
      ],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: cleanEnvironment,
      },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("launcher argv was invalid");
  });

  it("routes every Node or pnpm mise task through the launcher", () => {
    for (const path of taskFiles(
      resolve(repositoryRoot, ".config/mise/tasks"),
    )) {
      const source = readFileSync(path, "utf8");
      expect(source, path).toMatch(/^#!\/bin\/sh\n/u);
      if (!/(mise which (?:node|pnpm)|node_modules\/)/u.test(source)) continue;
      expect(source, path).toContain("trusted-node-launcher");
    }
  });

  it("ignores hostile shell, PATH, loader, package-manager, and mise configuration", () => {
    const scratch = mkdtempSync(join(tmpdir(), "trusted-node-launcher-"));
    const shellHook = join(scratch, "shell-hook");
    writeFileSync(shellHook, "echo shell-hook-ran\n");
    const cleanEnvironment: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: scratch,
      BASH_ENV: shellHook,
      ENV: shellHook,
      CDPATH: scratch,
      GLOBIGNORE: "*",
      NODE_PATH: scratch,
      NPM_CONFIG_USERCONFIG: join(scratch, "npmrc"),
      PNPM_HOME: scratch,
      MISE_CONFIG_FILE: join(scratch, "mise.toml"),
      LD_LIBRARY_PATH: scratch,
      DYLD_INSERT_LIBRARIES: join(scratch, "missing.dylib"),
      TSX_TSCONFIG_PATH: join(scratch, "tsx.json"),
      VITEST_POOL_ID: "attacker-pool",
      UV_THREADPOOL_SIZE: "128",
      OPENSSL_CONF: join(scratch, "openssl.cnf"),
    };
    delete cleanEnvironment.NODE_OPTIONS;
    const result = spawnSync(
      launcher,
      [
        pinnedNode,
        "-e",
        "process.stdout.write(JSON.stringify({path:process.env.PATH,bash:process.env.BASH_ENV,node:process.env.NODE_PATH,npm:process.env.NPM_CONFIG_USERCONFIG,pnpm:process.env.PNPM_HOME,mise:process.env.MISE_CONFIG_FILE,loader:process.env.LD_LIBRARY_PATH,dyld:process.env.DYLD_INSERT_LIBRARIES,tsx:process.env.TSX_TSCONFIG_PATH,vitest:process.env.VITEST_POOL_ID,uv:process.env.UV_THREADPOOL_SIZE,openssl:process.env.OPENSSL_CONF}))",
      ],
      { cwd: repositoryRoot, encoding: "utf8", env: cleanEnvironment },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ path: "/usr/bin:/bin" });
    expect(result.stdout).not.toContain("shell-hook-ran");
  });
});
