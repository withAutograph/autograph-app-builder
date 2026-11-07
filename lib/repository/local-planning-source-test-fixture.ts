/* oxlint-disable eslint/require-await -- Filesystem-backed provider ports run the actual archive/Git/merge programs. */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BuilderSandboxSession } from "../sandbox/builder-sandbox";
import { prepareDevelopmentSandboxWorkspace } from "./supported-template";

const writeFixtureFile = (base: string, file: string, content: string) => {
  const target = path.join(base, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
};

export const localPlanningSourceArchiveFixture = async () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "owned-archive-source-")));
  const source = path.join(root, "source");
  const workspace = path.join(root, "workspace");
  mkdirSync(source);
  mkdirSync(workspace);
  const git = (...args: string[]) =>
    execFileSync(
      "/usr/bin/git",
      ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-C", source, ...args],
      { encoding: "utf-8" },
    ).trim();
  git("init", "--quiet");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.test");
  writeFixtureFile(source, "seed.txt", "shared ancestor\n");
  git("add", ".");
  git("commit", "--quiet", "-m", "shared ancestor");
  writeFixtureFile(source, ".gitignore", ".app-builder/\nnode_modules/\n.env.local\n");
  writeFixtureFile(source, "shared.txt", "old trusted source\n");
  writeFixtureFile(source, "apps/example/app/page.tsx", "old source app\n");
  git("add", ".");
  git("commit", "--quiet", "-m", "original source");
  const translate = (value: string) =>
    value.startsWith("/workspace")
      ? workspace + value.slice("/workspace".length)
      : path.resolve(workspace, value);
  const store = (file: string, bytes: Uint8Array | string) => {
    const target = translate(file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  };
  const read = (file: string) => {
    try {
      return readFileSync(translate(file));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return null;
      }
      throw error;
    }
  };
  const sandbox: BuilderSandboxSession = {
    id: "same-owned-workspace",
    readBinaryFile: async (options) => read(options.path),
    readFile: async (options) => {
      const bytes = read(options.path);
      return bytes === null
        ? null
        : new ReadableStream({
            start(controller) {
              controller.enqueue(bytes);
              controller.close();
            },
          });
    },
    readTextFile: async (options) => read(options.path)?.toString("utf-8") ?? null,
    removePath: async (options) => {
      rmSync(translate(options.path), {
        force: options.force ?? false,
        recursive: options.recursive ?? false,
      });
    },
    resolvePath: translate,
    run: async (options) => {
      const result = spawnSync(
        "/bin/bash",
        ["-c", options.command.replaceAll("/workspace", workspace)],
        {
          cwd: translate(options.workingDirectory ?? "."),
          encoding: "utf-8",
          env: { NODE_ENV: "test", PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin` },
        },
      );
      return { exitCode: result.status ?? 1, stderr: result.stderr, stdout: result.stdout };
    },
    setNetworkPolicy: async () => {
      /* File-backed fixture has no network lifecycle. */
    },
    spawn: async () => {
      throw new Error("unused spawn");
    },
    writeBinaryFile: async (options) => {
      store(options.path, options.content);
    },
    writeFile: async (options) => {
      store(options.path, new Uint8Array(await new Response(options.content).arrayBuffer()));
    },
    writeTextFile: async (options) => {
      store(options.path, options.content);
    },
  };
  const original = await prepareDevelopmentSandboxWorkspace(source, sandbox, "normal-prepare");
  const candidate = path.join(workspace, "repository");
  writeFixtureFile(candidate, "apps/example/app/page.tsx", "saved private app\n");
  writeFixtureFile(candidate, "apps/example/.config/mise/tasks/check", "saved app task\n");
  writeFixtureFile(
    candidate,
    "apps/example/schema/release/v1/release.json",
    "saved immutable release\n",
  );
  writeFixtureFile(candidate, ".config/app-specs/example.md", "saved product\n");
  writeFixtureFile(candidate, ".env.local", "private retained\n");
  writeFixtureFile(candidate, "node_modules/cache", "retained dependency cache\n");
  return {
    candidate,
    dispose: () => {
      rmSync(root, { force: true, recursive: true });
    },
    git,
    original,
    root,
    sandbox,
    source,
    workspace,
    write: writeFixtureFile,
  };
};
