import type { APIError, Drive, Sandbox } from "@vercel/sandbox";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SandboxProviderSessionContext } from "eve/sandbox/provider";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readSandboxGitHubSourceSnapshot } from "../repository/sandbox-github-source";
import { materializeBuilderSandboxGitSource } from "./builder-sandbox";
import { createBuilderVercelProvider } from "./vercel-backend";
import { createVercelSdkSession } from "./vercel-sdk-session";
import type { VercelSdkSessionNative } from "./vercel-sdk-session";
import {
  clearVercelSessionGitSource,
  configureVercelSessionGitSource,
} from "./vercel-session-source";

/* oxlint-disable sonarjs/no-os-command-from-path -- Run real Git only in disposable local repository fixtures. */

const sdk = vi.hoisted(() => ({
  create:
    vi.fn<(options: Parameters<typeof Sandbox.create>[0]) => Promise<Pick<Sandbox, "name">>>(),
}));
const drives = vi.hoisted(() => ({
  getOrCreate:
    vi.fn<
      (
        options: Parameters<typeof Drive.getOrCreate>[0],
      ) => Promise<Pick<Drive, "driveId" | "name" | "projectId" | "region">>
    >(),
  list: vi.fn(),
}));
const authority = vi.hoisted(() => vi.fn());
// oxlint-disable-next-line anti-slop/no-module-mocking -- External provider boundary; fixtures never create Vercel resources.
vi.mock("@vercel/sandbox", async () => ({
  ...(await vi.importActual<{ APIError: typeof APIError }>("@vercel/sandbox")),
  DEFAULT_SANDBOX_REGION: "iad1",
  Drive: drives,
  Sandbox: sdk,
}));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Persistent command authority is the external boundary in this provider fixture.
vi.mock("./deployment-execution-lease", () => ({ assertHostedSandboxCommandAuthority: authority }));

const remote = "https://github.com/acme/private.git";
const token = "fixture-read-credential";
const cleanup: string[] = [];
afterEach(() => {
  for (const directory of cleanup.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
  authority.mockReset();
  sdk.create.mockReset();
  drives.getOrCreate.mockReset();
  drives.list.mockReset();
  clearVercelSessionGitSource("late-source-fixture");
});

const fixture = () => {
  const directory = mkdtempSync(path.join(tmpdir(), "late-builder-source-"));
  cleanup.push(directory);
  const repository = path.join(directory, "origin");
  const workspace = path.join(directory, "workspace");
  mkdirSync(repository);
  mkdirSync(workspace);
  const localGit = (args: string[]) =>
    execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
      cwd: repository,
      encoding: "utf-8",
    }).trim();
  localGit(["init", "--quiet", "--initial-branch=main"]);
  writeFileSync(path.join(repository, "source.txt"), "selected source\n");
  localGit(["add", "."]);
  localGit([
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "source",
  ]);
  const sha = localGit(["rev-parse", "HEAD"]);
  const tree = localGit(["rev-parse", "HEAD^{tree}"]);
  const events: string[] = [];
  const translate = (value: string) =>
    value
      .replaceAll("/workspace", workspace)
      .replaceAll("/vercel/sandbox", path.join(directory, "missing-provider-root"));
  const native = {
    delete: vi.fn().mockResolvedValue(null),
    mounts: { "/workspace": { drive: "source-drive", mode: "read-write" } },
    stop: vi.fn().mockResolvedValue(null),
    expiresAt: new Date(Date.now() + 30_000),
    extendTimeout: vi.fn(async () => {
      events.push("extend");
      await Promise.resolve();
    }),
    fs: {
      appendFile: vi.fn().mockResolvedValue(null),
      mkdir: vi.fn(async (value: string) => {
        mkdirSync(translate(value), { recursive: true });
        await Promise.resolve();
        return translate(value);
      }),
      rm: vi.fn().mockResolvedValue(null),
      writeFile: vi.fn().mockResolvedValue(null),
    },
    name: "same-existing-vm",
    readFile: vi.fn(),
    readFileToBuffer: vi.fn(),
    runCommand: vi.fn(
      async (options: {
        cmd: string;
        args: string[];
        cwd?: string;
        env?: Record<string, string>;
      }) => {
        await Promise.resolve();
        events.push("command");
        const args = options.args.map(translate);
        if (options.cmd === "printenv") {
          return {
            exitCode: 0,
            kill: vi.fn().mockResolvedValue(null),
            stderr: () => Promise.resolve(""),
            stdout: () => Promise.resolve("/home/vercel\n"),
            wait: () => Promise.resolve({ exitCode: 0 }),
          };
        }
        const cloned = options.cmd === "git" && args.includes("clone");
        // The fixture executes real Git and file placement, but substitutes a
        // local origin so no GitHub or Vercel requests can occur.
        if (cloned) {
          args[args.indexOf(remote)] = repository;
        }
        const moving = options.cmd === "mv" && process.platform === "darwin";
        // The managed Linux VM has GNU mv. On macOS the fixture performs its
        // no-clobber placement through Node while preserving real file I/O.
        const moveProgram = `const fs=require("node:fs");
try { fs.lstatSync(process.argv[2]); process.exit(0); }
catch(error) { if(error.code !== "ENOENT") throw error; }
fs.renameSync(process.argv[1],process.argv[2]);`;
        const result = spawnSync(
          options.cmd === "node" || moving ? process.execPath : options.cmd,
          moving ? ["-e", moveProgram, ...args.slice(-2)] : args,
          {
            cwd: options.cwd === undefined ? workspace : translate(options.cwd),
            encoding: "utf-8",
            env: { ...process.env, ...options.env },
          },
        );
        if (cloned && result.status === 0) {
          execFileSync("git", ["-C", args.at(-1) ?? "", "remote", "set-url", "origin", remote]);
        }
        return {
          exitCode: result.status ?? 1,
          kill: vi.fn().mockResolvedValue(null),
          stderr: async () => await Promise.resolve(result.stderr),
          stdout: async () => await Promise.resolve(result.stdout),
          wait: async () => await Promise.resolve({ exitCode: result.status ?? 1 }),
        };
      },
    ),
    update: vi.fn().mockResolvedValue(null),
    writeFiles: vi.fn().mockResolvedValue(null),
  };
  const authorize = vi.fn(async () => {
    events.push("authorize");
    await Promise.resolve();
  });
  const sdkNative = {
    ...native,
    runCommand: vi.fn().mockImplementation(native.runCommand),
  } satisfies VercelSdkSessionNative;
  drives.getOrCreate.mockImplementation((options: { name: string }) =>
    Promise.resolve({
      driveId: "source-drive",
      name: options.name,
      projectId: "source-project",
      region: "iad1",
    }),
  );
  return { authorize, directory, events, native, sdkNative, sha, tree, workspace };
};

describe("late source acquisition on an existing Builder VM", () => {
  it.each(["main", "commit"])(
    "composes source-less eager start, private %s selection, acquisition and snapshot on the same VM",
    async (revision) => {
      const f = fixture();
      sdk.create.mockResolvedValue(f.native);
      authority.mockImplementation(f.authorize);
      const provider = createBuilderVercelProvider();
      // SAFETY: start reads only session.id; this fixture supplies that exact field.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Fixture supplies the field consumed by start.
      const context = { session: { id: "late-source-fixture" } } as SandboxProviderSessionContext;
      const started = await provider.start(context, undefined, { files: [] });
      expect(sdk.create.mock.calls[0]?.[0]).not.toHaveProperty("source");
      const source = { revision: revision === "commit" ? f.sha : revision, token, url: remote };
      configureVercelSessionGitSource({ sessionId: context.session.id, source });
      mkdirSync(path.join(f.workspace, "assets"));
      writeFileSync(path.join(f.workspace, "assets", "prior.txt"), "existing session asset");
      // Resume the eager-created VM before the workflow resolves its source.
      const session = started.handle.sandbox;
      const snapshot = await readSandboxGitHubSourceSnapshot(
        session,
        { repository: remote },
        async () => {
          await materializeBuilderSandboxGitSource(session, source);
        },
      );
      expect(snapshot).toMatchObject({
        sourcePath: "/workspace/repository",
        sourceSha: f.sha,
        sourceTree: f.tree,
      });
      expect(readFileSync(path.join(f.workspace, "repository", "source.txt"), "utf-8")).toBe(
        "selected source\n",
      );
      expect(readFileSync(path.join(f.workspace, "assets", "prior.txt"), "utf-8")).toBe(
        "existing session asset",
      );
      expect(session.id).toBe("same-existing-vm");
      expect(sdk.create).toHaveBeenCalledOnce();
      const clone = f.native.runCommand.mock.calls.find(
        ([options]) => options.cmd === "git" && options.args.includes("clone"),
      )?.[0];
      expect(clone?.args).not.toContain("bash");
      expect(clone?.env?.GIT_CONFIG_KEY_0).toBe(`http.${remote}.extraheader`);
      const authorization = Buffer.from(`x-access-token:${token}`).toString("base64");
      expect(clone?.env?.GIT_CONFIG_VALUE_0).toBe(`Authorization: Basic ${authorization}`);
      expect(
        readFileSync(path.join(f.workspace, "repository", ".git", "config"), "utf-8"),
      ).not.toMatch(/credential|Authorization|fixture-read/u);
      expect(
        JSON.stringify(
          f.native.runCommand.mock.calls.map(([options]) => ({
            args: options.args,
            cmd: options.cmd,
          })),
        ),
      ).not.toContain(token);
      expect(JSON.stringify(started.state)).not.toContain(token);
      expect(f.native.extendTimeout).toHaveBeenCalled();
      let authorized = false;
      for (const event of f.events.slice(1)) {
        if (event === "authorize") {
          authorized = true;
        }
        if (event === "command") {
          expect(authorized).toBe(true);
          authorized = false;
        }
      }
    },
  );

  it("initializes selected template source inside the mounted workspace before the first callback-free snapshot", async () => {
    const f = fixture();
    sdk.create.mockResolvedValue(f.native);
    configureVercelSessionGitSource({
      sessionId: "late-source-fixture",
      source: { revision: f.sha, token, url: remote },
    });
    // SAFETY: the provider reads only the supplied native session identity.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Only session.id is consumed by this provider lifecycle fixture.
    const context = { session: { id: "late-source-fixture" } } as SandboxProviderSessionContext;
    const started = await createBuilderVercelProvider().start(context, undefined, { files: [] });
    const snapshot = await readSandboxGitHubSourceSnapshot(started.handle.sandbox, {
      repository: remote,
    });
    expect(snapshot).toMatchObject({
      sourcePath: "/workspace/repository",
      sourceSha: f.sha,
      sourceTree: f.tree,
    });
    expect(readFileSync(path.join(f.workspace, "repository", "source.txt"), "utf-8")).toBe(
      "selected source\n",
    );
    expect(sdk.create.mock.calls[0]?.[0]).not.toHaveProperty("source");
    expect(sdk.create.mock.calls[0]?.[0]?.mounts?.["/workspace"]).toMatchObject({
      driveId: "source-drive",
    });
    expect(drives.getOrCreate).toHaveBeenCalledOnce();
    const clone = f.native.runCommand.mock.calls.find(
      ([options]) => options.cmd === "git" && options.args.includes("clone"),
    )?.[0];
    expect(clone?.cwd).toBe("/workspace");
    expect(clone?.args.at(-1)).toMatch(/^\/workspace\/\.app-builder\/source-acquisition\//u);
    const authorization = Buffer.from(`x-access-token:${token}`).toString("base64");
    expect(clone?.env?.GIT_CONFIG_VALUE_0).toBe(`Authorization: Basic ${authorization}`);
    expect(JSON.stringify(started.state)).not.toContain(token);
    expect(
      JSON.stringify(
        f.native.runCommand.mock.calls.map(([options]) => ({
          cmd: options.cmd,
          args: options.args,
        })),
      ),
    ).not.toContain(token);
    expect(
      readFileSync(path.join(f.workspace, "repository", ".git", "config"), "utf-8"),
    ).not.toMatch(/credential|Authorization|fixture-read/u);
    await started.handle.onSessionStop();
  });

  it("retries partial startup on the same Drive after an unknown placement result without replacing private Git state", async () => {
    const f = fixture();
    sdk.create.mockResolvedValue(f.native);
    configureVercelSessionGitSource({
      sessionId: "late-source-fixture",
      source: { revision: f.sha, token, url: remote },
    });
    // SAFETY: the provider reads only the supplied native session identity.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Only session.id is consumed by this provider lifecycle fixture.
    const context = { session: { id: "late-source-fixture" } } as SandboxProviderSessionContext;
    const run = f.native.runCommand.getMockImplementation();
    if (run === undefined) {
      throw new Error("Missing local command implementation");
    }
    let losePlacement = true;
    f.native.runCommand.mockImplementation(async (options) => {
      const result = await run(options);
      if (options.cmd === "mv" && losePlacement) {
        losePlacement = false;
        throw new Error("placement response lost");
      }
      return result;
    });
    const provider = createBuilderVercelProvider();
    await expect(provider.start(context, undefined, { files: [] })).rejects.toThrow(
      "could not complete",
    );
    const root = path.join(f.workspace, "repository");
    const git = (args: string[]) =>
      execFileSync("git", ["-C", root, "-c", "commit.gpgsign=false", ...args], {
        encoding: "utf-8",
      }).trim();
    writeFileSync(path.join(root, "source.txt"), "private committed edit\n");
    git(["add", "source.txt"]);
    git([
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "private edit",
    ]);
    const editedHead = git(["rev-parse", "HEAD"]);
    writeFileSync(path.join(root, "source.txt"), "private staged edit\n");
    git(["add", "source.txt"]);
    writeFileSync(path.join(root, "source.txt"), "private working edit\n");
    writeFileSync(path.join(root, ".git", "info", "exclude"), "private.env\n");
    writeFileSync(path.join(root, "private.env"), "private ignored bytes\n");
    const indexBefore = readFileSync(path.join(root, ".git", "index"));
    const started = await provider.start(context, undefined, { files: [] });
    expect(git(["rev-parse", "HEAD"])).toBe(editedHead);
    expect(readFileSync(path.join(root, ".git", "index"))).toEqual(indexBefore);
    expect(git(["show", ":source.txt"])).toBe("private staged edit");
    expect(readFileSync(path.join(root, "source.txt"), "utf-8")).toBe("private working edit\n");
    expect(readFileSync(path.join(root, "private.env"), "utf-8")).toBe("private ignored bytes\n");
    expect(
      f.native.runCommand.mock.calls.filter(([options]) => options.args.includes("clone")),
    ).toHaveLength(1);
    expect(drives.getOrCreate.mock.calls[0]?.[0].name).toBe(
      drives.getOrCreate.mock.calls[1]?.[0].name,
    );
    expect(drives.list).not.toHaveBeenCalled();
    await started.handle.onSessionStop();
  });

  it("retries interrupted startup clone in a fresh stage while retaining the incomplete stage", async () => {
    const f = fixture();
    sdk.create.mockResolvedValue(f.native);
    configureVercelSessionGitSource({
      sessionId: "late-source-fixture",
      source: { token, url: remote },
    });
    // SAFETY: the provider reads only the supplied native session identity.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Only session.id is consumed by this provider lifecycle fixture.
    const context = { session: { id: "late-source-fixture" } } as SandboxProviderSessionContext;
    const run = f.native.runCommand.getMockImplementation();
    if (run === undefined) {
      throw new Error("Missing local command implementation");
    }
    let interruptedStage: string | undefined;
    f.native.runCommand.mockImplementation(async (options) => {
      if (
        options.cmd === "git" &&
        options.args.includes("clone") &&
        interruptedStage === undefined
      ) {
        const stage = options.args.at(-1);
        if (stage === undefined) {
          throw new Error("Missing source acquisition destination");
        }
        interruptedStage = stage.replace("/workspace", f.workspace);
        mkdirSync(interruptedStage, { recursive: true });
        writeFileSync(
          path.join(interruptedStage, "partial.txt"),
          "retained incomplete source bytes",
        );
        throw new Error("clone response lost");
      }
      return await run(options);
    });
    const provider = createBuilderVercelProvider();
    await expect(provider.start(context, undefined, { files: [] })).rejects.toThrow(
      "could not complete",
    );
    if (interruptedStage === undefined) {
      throw new Error("Interrupted source stage was not created");
    }
    const started = await provider.start(context, undefined, { files: [] });
    expect(readFileSync(path.join(interruptedStage, "partial.txt"), "utf-8")).toBe(
      "retained incomplete source bytes",
    );
    expect(readFileSync(path.join(f.workspace, "repository", "source.txt"), "utf-8")).toBe(
      "selected source\n",
    );
    const clones = f.native.runCommand.mock.calls.filter(([options]) =>
      options.args.includes("clone"),
    );
    expect(clones).toHaveLength(2);
    expect(clones[0]?.[0].args.at(-1)).not.toBe(clones[1]?.[0].args.at(-1));
    const snapshot = await readSandboxGitHubSourceSnapshot(started.handle.sandbox, {
      repository: remote,
    });
    expect(snapshot.sourceSha).toBe(f.sha);
    expect(drives.getOrCreate.mock.calls[0]?.[0].name).toBe(
      drives.getOrCreate.mock.calls[1]?.[0].name,
    );
    expect(drives.list).not.toHaveBeenCalled();
    await started.handle.onSessionStop();
  });

  it.each(["non-Git", "foreign repository"])(
    "preserves an occupied %s workspace during startup retry",
    async (occupied) => {
      const f = fixture();
      const root = path.join(f.workspace, "repository");
      mkdirSync(root);
      writeFileSync(path.join(root, "private.txt"), "retained private work");
      if (occupied === "foreign repository") {
        execFileSync("git", ["init", "--quiet", root]);
        execFileSync("git", [
          "-C",
          root,
          "remote",
          "add",
          "origin",
          "https://github.com/acme/other.git",
        ]);
      }
      configureVercelSessionGitSource({
        sessionId: "late-source-fixture",
        source: { token, url: remote },
      });
      sdk.create.mockResolvedValue(f.native);
      // SAFETY: the provider reads only the supplied native session identity.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Only session.id is consumed by this provider lifecycle fixture.
      const context = { session: { id: "late-source-fixture" } } as SandboxProviderSessionContext;
      await expect(
        createBuilderVercelProvider().start(context, undefined, { files: [] }),
      ).rejects.toThrow();
      expect(readFileSync(path.join(root, "private.txt"), "utf-8")).toBe("retained private work");
      expect(
        f.native.runCommand.mock.calls.some(([options]) => options.args.includes("clone")),
      ).toBe(false);
      expect(drives.list).not.toHaveBeenCalled();
    },
  );

  it("preserves a valid existing checkout and refuses an occupied non-Git workspace", async () => {
    const f = fixture();
    const session = createVercelSdkSession(f.sdkNative, () => f.sdkNative, f.authorize);
    const materialize = vi.fn(async () => {
      await materializeBuilderSandboxGitSource(session, { token, url: remote });
    });
    mkdirSync(path.join(f.workspace, "repository"));
    writeFileSync(path.join(f.workspace, "repository", "prior.txt"), "private work");
    await expect(
      readSandboxGitHubSourceSnapshot(session, { repository: remote }, materialize),
    ).rejects.toThrow("occupied");
    expect(materialize).not.toHaveBeenCalled();
    await expect(materialize()).rejects.toThrow("occupied");
    expect(readFileSync(path.join(f.workspace, "repository", "prior.txt"), "utf-8")).toBe(
      "private work",
    );
    rmSync(path.join(f.workspace, "repository"), { recursive: true });
    await materialize();
    writeFileSync(path.join(f.workspace, "repository", "draft.txt"), "live edits");
    materialize.mockClear();
    await readSandboxGitHubSourceSnapshot(session, { repository: remote }, materialize);
    expect(materialize).not.toHaveBeenCalled();
    expect(readFileSync(path.join(f.workspace, "repository", "draft.txt"), "utf-8")).toBe(
      "live edits",
    );
  });

  it("reuses the staged checkout after an uncertain placement response and resolves the current provider", async () => {
    const f = fixture();
    const oldNative = {
      ...f.sdkNative,
      runCommand: vi.fn().mockRejectedValue(new Error("old VM")),
    };
    const session = createVercelSdkSession(oldNative, () => f.sdkNative, f.authorize);
    const original = f.native.runCommand.getMockImplementation();
    if (original === undefined) {
      throw new Error("Fixture command implementation missing");
    }
    let failPlacement = true;
    f.native.runCommand.mockImplementation(async (options) => {
      if (options.cmd === "mv" && failPlacement) {
        failPlacement = false;
        throw new Error(`uncertain provider response contains ${token}`);
      }
      return await original(options);
    });
    await expect(
      materializeBuilderSandboxGitSource(session, { token, url: remote }),
    ).rejects.toThrow("could not complete");
    await materializeBuilderSandboxGitSource(session, {
      token: "fresh-retry-credential",
      url: remote,
    });
    expect(
      f.native.runCommand.mock.calls.filter(([options]) => options.args.includes("clone")),
    ).toHaveLength(1);
    expect(oldNative.runCommand).not.toHaveBeenCalled();
    expect(readFileSync(path.join(f.workspace, "repository", "source.txt"), "utf-8")).toBe(
      "selected source\n",
    );
  });

  it("observes the canonical checkout on snapshot retry after placement succeeds but the SDK response is lost", async () => {
    const f = fixture();
    mkdirSync(path.join(f.workspace, "assets"));
    writeFileSync(path.join(f.workspace, "assets", "prior.txt"), "existing asset");
    const session = createVercelSdkSession(f.sdkNative, () => f.sdkNative, f.authorize);
    const original = f.native.runCommand.getMockImplementation();
    if (original === undefined) {
      throw new Error("Fixture command implementation missing");
    }
    let loseResponse = true;
    f.native.runCommand.mockImplementation(async (options) => {
      const result = await original(options);
      if (options.cmd === "mv" && loseResponse) {
        loseResponse = false;
        throw new Error(`lost provider response contains ${token}`);
      }
      return result;
    });
    const materialize = vi.fn(async () => {
      await materializeBuilderSandboxGitSource(session, { token, url: remote });
    });
    await expect(
      readSandboxGitHubSourceSnapshot(session, { repository: remote }, materialize),
    ).rejects.toThrow("could not complete");
    const snapshot = await readSandboxGitHubSourceSnapshot(
      session,
      { repository: remote },
      materialize,
    );
    expect(snapshot).toMatchObject({
      sourcePath: "/workspace/repository",
      sourceSha: f.sha,
      sourceTree: f.tree,
    });
    expect(materialize).toHaveBeenCalledOnce();
    expect(
      f.native.runCommand.mock.calls.filter(([options]) => options.args.includes("clone")),
    ).toHaveLength(1);
    expect(readFileSync(path.join(f.workspace, "assets", "prior.txt"), "utf-8")).toBe(
      "existing asset",
    );
  });

  it("authorizes before any SDK operation and hides provider response bodies and credential errors", async () => {
    const f = fixture();
    const denied = createVercelSdkSession(
      f.sdkNative,
      () => f.sdkNative,
      async () => {
        await Promise.resolve();
        throw new Error("no lease");
      },
    );
    await expect(
      materializeBuilderSandboxGitSource(denied, { token, url: remote }),
    ).rejects.toThrow("no lease");
    expect(f.native.runCommand).not.toHaveBeenCalled();
    expect(f.native.fs.mkdir).not.toHaveBeenCalled();
    const original = f.native.runCommand.getMockImplementation();
    if (original === undefined) {
      throw new Error("Fixture command implementation missing");
    }
    f.native.runCommand.mockImplementation(async (options) => {
      if (options.args.includes("clone")) {
        throw new Error(`provider response contains ${token}`);
      }
      return await original(options);
    });
    const session = createVercelSdkSession(f.sdkNative, () => f.sdkNative, f.authorize);
    let observedError: unknown;
    try {
      await materializeBuilderSandboxGitSource(session, { token, url: remote });
    } catch (error) {
      observedError = error;
    }
    expect(observedError).toBeInstanceOf(Error);
    expect(String(observedError)).not.toContain(token);
    expect(observedError).not.toHaveProperty("cause");
  });
});
