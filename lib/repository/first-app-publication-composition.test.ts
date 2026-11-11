/* oxlint-disable eslint/require-await -- Local filesystem doubles implement the asynchronous Sandbox ports. */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SandboxSession } from "eve/sandbox";
import { afterEach, expect, it, vi } from "vitest";
import type { z } from "zod";
import {
  acquiredSourceLacksApp,
  planFirstAppPublicationComposition,
} from "./first-app-publication-composition";

const appId = "new-workspace";
const selected = `apps/${appId}`;
const directories: string[] = [];
const bun = process.env.BUN_BINARY;
const hasBun = bun !== undefined && existsSync(bun);
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const json = (value: z.infer<ReturnType<typeof z.json>>) => `${JSON.stringify(value, null, 2)}\n`;
const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    "/usr/bin/git",
    ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args],
    {
      cwd,
      encoding: "utf-8",
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  ).trim();

const commit = (root: string) => {
  git(root, "add", "--all");
  git(root, "commit", "-m", "Controlled immutable repository");
  return { sha: git(root, "rev-parse", "HEAD"), tree: git(root, "rev-parse", "HEAD^{tree}") };
};

const write = (root: string, filename: string, content: string) => {
  const file = path.join(root, filename);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
};

const fixture = (realBun = false) => {
  const workspace = realpathSync(mkdtempSync(path.join(tmpdir(), "first-app-publication-")));
  directories.push(workspace);
  const repository = path.join(workspace, "repository");
  const apply = path.join(workspace, "apply");
  mkdirSync(repository);
  mkdirSync(apply);
  git(repository, "init", "--initial-branch=main");
  git(repository, "config", "user.name", "Controlled Fixture");
  git(repository, "config", "user.email", "fixture@example.test");
  git(repository, "remote", "add", "origin", "https://github.com/example/apps.git");
  const packageJson = {
    name: "controlled-platform",
    private: true,
    workspaces: ["apps/existing", "packages/*"],
    catalog: { shared: "workspace:*" },
    scripts: { keep: "preserved-command" },
  };
  const routes = { applications: { existing: { packageName: "@autograph/existing" } } };
  const planner = "packages/platform-microfrontends/src/policy/config-registration.ts";
  write(repository, "package.json", json(packageJson));
  write(repository, "microfrontends.json", json(routes));
  write(
    repository,
    "apps/existing/package.json",
    json({ name: "@autograph/existing", version: "1.0.0" }),
  );
  write(repository, "packages/shared/package.json", json({ name: "shared", version: "1.0.0" }));
  write(
    repository,
    planner,
    `
    import { createHash } from "node:crypto";
    export function planMicrofrontendRegistration(bytes, request) {
      const hash = value => createHash("sha256").update(value).digest("hex");
      const config = JSON.parse(bytes);
      const assetRoute = "/" + request.projectName + "/:path*";
      config.applications[request.projectName] = {
        packageName: request.packageName, routes: request.routes,
      };
      const proposedBytes = JSON.stringify(config) + "\\n";
      return {
        proposedBytes, assetRoute, projectName: request.projectName,
        oldDigest: hash(bytes), newDigest: hash(proposedBytes),
      };
    }
  `,
  );
  const cache = path.join(workspace, "bun-cache");
  const runBun = (cwd: string, ...args: string[]) => {
    if (bun === undefined) {
      throw new Error("Controlled Bun executable required");
    }
    return spawnSync(bun, args, {
      cwd,
      encoding: "utf-8",
      env: { ...process.env, BUN_INSTALL_CACHE_DIR: cache },
    });
  };
  if (realBun) {
    const installation = runBun(repository, "install", "--lockfile-only", "--ignore-scripts");
    expect(installation.status).toBe(0);
  } else {
    write(repository, "bun.lock", "synthetic base lock\n");
  }
  const acquired = commit(repository);
  write(repository, planner, "throw new Error('mutable planner must not run');\n");
  write(
    apply,
    `${selected}/package.json`,
    json({
      name: `@autograph/${appId}`,
      dependencies: { shared: "catalog:" },
    }),
  );
  write(apply, "package.json", json({ name: "foreign-root-edit" }));
  write(apply, "bun.lock", "foreign lock edit\n");
  write(apply, "microfrontends.json", json({ applications: { foreign: {} } }));
  const remoteFetch = vi
    .fn<(command: string) => { exitCode: number; stdout: string; stderr: string }>()
    .mockReturnValue({
      exitCode: 128,
      stderr: "remote: Repository not found.\nprivate fake provider detail",
      stdout: "",
    });
  const sandbox: Pick<SandboxSession, "run" | "readTextFile" | "writeTextFile" | "removePath"> = {
    async run({ command, workingDirectory, abortSignal }) {
      abortSignal?.throwIfAborted();
      if (command.includes('"protocol":"protocol.https"')) {
        return remoteFetch(command);
      }
      const cwd = (workingDirectory ?? "/workspace").replace("/workspace", workspace);
      const actual = command
        .replaceAll("/workspace", workspace)
        .replace(/^node /u, `'${process.execPath}' `);
      if (actual.endsWith("bun install --lockfile-only --ignore-scripts")) {
        const result = runBun(cwd, "install", "--lockfile-only", "--ignore-scripts");
        return { exitCode: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
      }
      const miseBun = actual.indexOf("mise exec --no-deps -- bun ");
      const source =
        miseBun === -1
          ? actual
          : `'${bun}' ${actual.slice(miseBun + "mise exec --no-deps -- bun ".length)}`;
      const result = spawnSync("/bin/sh", ["-c", source], { cwd, encoding: "utf-8" });
      return { exitCode: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
    },
    async readTextFile({ path: filename }) {
      return readFileSync(path.join(workspace, filename), "utf-8");
    },
    async writeTextFile({ path: filename, content }) {
      write(workspace, filename, content);
    },
    async removePath({ path: filename }) {
      rmSync(path.join(workspace, filename), { recursive: true, force: true });
    },
  };
  const input = {
    appId,
    acquired,
    applyRoot: "/workspace/apply",
    destination: {
      owner: "example",
      name: "apps",
      headSha: acquired.sha,
      headTree: acquired.tree,
      defaultBranch: "main",
    },
    // SAFETY: This isolated filesystem fixture supplies every Sandbox port used by the helper.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Limit fixture authority to its local test ports.
    sandbox: sandbox as SandboxSession,
  };
  return { apply, input, packageJson, remoteFetch, repository, routes, workspace, write };
};

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

it.skipIf(!hasBun)(
  "derives the root diff from the exact destination and only the new app manifest",
  async () => {
    const f = fixture(true);
    const before = readFileSync(path.join(f.repository, "bun.lock"), "utf-8");
    expect(await acquiredSourceLacksApp(f.input)).toBe(true);
    const files = await planFirstAppPublicationComposition(f.input);
    expect(files.map(({ path: filename }) => filename)).toEqual([
      "package.json",
      "microfrontends.json",
      "bun.lock",
    ]);
    const contents = new Map(files.map((file) => [file.path, file]));
    const manifest = contents.get("package.json")?.content ?? "";
    const routes = contents.get("microfrontends.json")?.content ?? "";
    const lock = contents.get("bun.lock")?.content ?? "";
    expect(JSON.parse(manifest)).toEqual({
      ...f.packageJson,
      workspaces: [...f.packageJson.workspaces, selected],
    });
    expect(JSON.parse(routes)).toMatchObject(f.routes);
    expect(routes).toContain(`@autograph/${appId}`);
    expect(before).not.toContain(`"${selected}"`);
    expect(lock).toContain(`"${selected}"`);
    expect(lock).toContain('"apps/existing"');
    expect(lock).not.toContain("foreign");
    for (const file of files) {
      expect(file.digest).toBe(digest(file.content));
      expect(file.mode).toBe("644");
    }
    expect(readFileSync(path.join(f.apply, "bun.lock"), "utf-8")).toBe("foreign lock edit\n");
    expect(readFileSync(path.join(f.repository, "bun.lock"), "utf-8")).toBe(before);
    expect(
      readdirSync(f.workspace).some((entry) => entry.startsWith(".first-app-publication-")),
    ).toBe(false);
    expect(f.remoteFetch).not.toHaveBeenCalled();
  },
);

it("treats a manifest-less app directory as existing in immutable acquired Git", async () => {
  const f = fixture();
  f.write(f.repository, `${selected}/notes.md`, "already exists\n");
  const acquired = commit(f.repository);
  expect(await acquiredSourceLacksApp({ ...f.input, acquired })).toBe(false);
  await expect(planFirstAppPublicationComposition({ ...f.input, acquired })).rejects.toThrow();
});

it("rejects a destination that now contains the selected app or a different immutable tree", async () => {
  const f = fixture();
  f.write(f.repository, `${selected}/notes.md`, "destination app\n");
  const next = commit(f.repository);
  await Promise.all(
    [next.tree, "0".repeat(40)].map(async (headTree) => {
      await expect(
        planFirstAppPublicationComposition({
          ...f.input,
          destination: { ...f.input.destination, headSha: next.sha, headTree },
        }),
      ).rejects.toThrow("exact new-app destination");
    }),
  );
});

it.each(["bun.lock", `${selected}/package.json`])(
  "rejects the candidate symlink at %s without writing through it",
  async (filename) => {
    const f = fixture();
    const target = path.join(f.apply, filename);
    const original = path.join(f.workspace, "unrelated-source");
    writeFileSync(original, "preserve this");
    rmSync(target);
    symlinkSync(original, target);
    await expect(planFirstAppPublicationComposition(f.input)).rejects.toThrow();
    expect(readFileSync(original, "utf-8")).toBe("preserve this");
  },
);

it("uses existing authorization only for an exact missing Git object and redacts transport errors", async () => {
  const f = fixture();
  const destination = { ...f.input.destination, headSha: "a".repeat(40), headTree: "b".repeat(40) };
  await expect(planFirstAppPublicationComposition({ ...f.input, destination })).rejects.toThrow(
    "Restore the saved repository access",
  );
  expect(f.remoteFetch).not.toHaveBeenCalled();
  const withDestinationFetch = vi.fn(async (fetch: () => Promise<void>) => {
    await fetch();
  });
  await expect(
    planFirstAppPublicationComposition({ ...f.input, destination, withDestinationFetch }),
  ).rejects.toThrow(
    "Builder could not fetch the current base branch (exit 128). remote: Repository not found.",
  );
  expect(withDestinationFetch).toHaveBeenCalledOnce();
  expect(f.remoteFetch).toHaveBeenCalledOnce();
  const command = f.remoteFetch.mock.calls[0]?.[0];
  expect(command).toContain('"transport":"https://github.com/example/apps.git"');
  expect(command).toContain(`"sha":"${destination.headSha}"`);
});

it("honors an already stopped review before asking for destination access", async () => {
  const f = fixture();
  const stop = new Error("review stopped");
  const controller = new AbortController();
  controller.abort(stop);
  const withDestinationFetch = vi.fn<(fetch: () => Promise<void>) => Promise<void>>();
  await expect(
    planFirstAppPublicationComposition({
      ...f.input,
      withDestinationFetch,
      signal: controller.signal,
    }),
  ).rejects.toBe(stop);
  expect(withDestinationFetch).not.toHaveBeenCalled();
  expect(
    readdirSync(f.workspace).some((entry) => entry.startsWith(".first-app-publication-")),
  ).toBe(false);
});

it.skipIf(!hasBun)(
  "projects the five retained framework pins without copying other catalog edits",
  async () => {
    const f = fixture(true);
    const frameworkUpgrade = {
      next: "16.4.7",
      react: "19.3.0",
      reactDom: "19.3.0",
      typesReact: "19.3.2",
      typesReactDom: "19.3.1",
    };
    f.write(
      f.apply,
      "package.json",
      json({
        catalog: { next: "99.0.0", foreign: "1.2.3", shared: "99.0.0" },
      }),
    );
    const files = await planFirstAppPublicationComposition({ ...f.input, frameworkUpgrade });
    const rootManifest = files.find((file) => file.path === "package.json");
    expect(rootManifest).toBeDefined();
    expect(JSON.parse(rootManifest?.content ?? "")).toEqual({
      ...f.packageJson,
      catalog: {
        ...f.packageJson.catalog,
        next: frameworkUpgrade.next,
        react: frameworkUpgrade.react,
        "react-dom": frameworkUpgrade.reactDom,
        "@types/react": frameworkUpgrade.typesReact,
        "@types/react-dom": frameworkUpgrade.typesReactDom,
      },
      workspaces: [...f.packageJson.workspaces, selected],
    });
    expect(files.find((file) => file.path === "bun.lock")?.content).not.toContain("99.0.0");
  },
);
