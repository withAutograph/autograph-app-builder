/* oxlint-disable eslint/require-await -- Async SDK test doubles preserve the native Promise contract while executing disposable local fixture commands. */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { initialDraftCandidatePaths } from "../../agent/tools/prepare_github_draft_review";
import {
  acquireCanonicalArrustedTemplate,
  ARRUSTED_TEMPLATE_REPOSITORY,
} from "../repository/arrusted-template";
import { sandboxGitHubSourceManifestProgram } from "../repository/sandbox-github-source";
import {
  readPreparedSandboxSourceManifest,
  readPreparedSandboxWorkspaceRecord,
} from "../repository/supported-template";
import type { PreparedSandboxWorkspace } from "../repository/supported-template";
import { createVercelSdkSession } from "../sandbox/vercel-sdk-session";
import type { VercelSdkSessionNative } from "../sandbox/vercel-sdk-session";

const hash = (content: string | Buffer) => createHash("sha256").update(content).digest("hex");

// Native SDK transport backed by disposable disk. The provider maps its mounted
// /workspace into the test directory; the production command and SDK reader run
// unchanged against those same bytes, including after handle reattachment.
const fixture = () => {
  const root = mkdtempSync(path.join(tmpdir(), "builder-baseline-recovery-"));
  const workspace = path.join(root, "workspace");
  const repository = path.join(workspace, "repository");
  const metadata = path.join(workspace, ".app-builder");
  mkdirSync(repository, { recursive: true });
  const git = (...args: string[]) =>
    execFileSync("/usr/bin/git", ["-C", repository, ...args], { encoding: "utf-8" }).trim();
  git("init", "--quiet");
  const originals = {
    "package.json": '{"workspaces":["apps/*"]}\n',
    "bun.lock": "original lock\n",
    "microfrontends.json": '{"applications":{}}\n',
    "shared.txt": "unchanged shared input\n",
  };
  for (const [name, content] of Object.entries(originals)) {
    writeFileSync(path.join(repository, name), content);
  }
  // Exceeds child_process's default buffered stdout allowance; recovery must
  // stream/hash blob bytes rather than return the source through command output.
  writeFileSync(path.join(repository, "binary.dat"), Buffer.alloc(2 * 1024 * 1024 + 7, 0xab));
  git("add", ".");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "-m",
    "original source",
  );
  const sourceSha = git("rev-parse", "HEAD");
  const sourceTree = git("rev-parse", "HEAD^{tree}");
  execFileSync(process.execPath, ["-e", sandboxGitHubSourceManifestProgram(repository, metadata)]);
  const manifest = readFileSync(path.join(metadata, "source-files.json"), "utf-8");
  const record: PreparedSandboxWorkspace = {
    adapter: "arrusted-development-v0",
    eligibilityDigest: "e".repeat(64),
    sourcePath: "/workspace/repository",
    sourceSha,
    sourceTree,
    workspaceDigest: hash(JSON.stringify(JSON.parse(manifest))),
    workspaceId: "same-owned-workspace",
    workspacePath: "/workspace/repository",
  };
  const mapped = (name: string) =>
    name
      .replaceAll("/workspace", workspace)
      .replaceAll(
        "PATH=/usr/local/bin:/usr/bin:/bin",
        `PATH=${path.dirname(process.execPath)}:/usr/bin:/bin`,
      );
  const native = (beforeCommand?: () => void): VercelSdkSessionNative => ({
    name: record.workspaceId,
    expiresAt: new Date(Date.now() + 600_000),
    extendTimeout: async () => {
      /* The disposable fixture does not expire. */
    },
    fs: {
      mkdir: async (name, options) => {
        mkdirSync(mapped(name), options);
      },
      rm: async (name, options) => {
        rmSync(mapped(name), options);
      },
    },
    readFileToBuffer: async ({ path: name }) =>
      existsSync(mapped(name)) ? readFileSync(mapped(name)) : null,
    readFile: async () => {
      throw new Error("Unexpected stream read");
    },
    writeFiles: async (files) => {
      for (const file of files) {
        const target = mapped(file.path);
        if (!target.startsWith(`${metadata}${path.sep}`)) {
          throw new Error("Unexpected source write");
        }
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, file.content);
      }
    },
    update: async () => {
      /* The fixture has no provider configuration. */
    },
    runCommand: async (options) => {
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Narrow the SDK overload before invoking a structured command.
      if (typeof options === "string") {
        throw new TypeError("The SDK session must provide a structured native command.");
      }
      beforeCommand?.();
      const output = spawnSync(options.cmd, options.args?.map(mapped) ?? [], {
        cwd: mapped(options.cwd ?? "/workspace"),
        encoding: "utf-8",
        env: {
          ...process.env,
          ...options.env,
          BASH_ENV: "/dev/null",
          HOME: root,
          PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
        },
      });
      if (output.error) {
        throw output.error;
      }
      // SAFETY: Recovery consumes only the native command's stdout, stderr,
      // wait and kill methods; SDK command identity is not used in this fixture.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The fixture supplies the native command methods consumed by SDK session recovery.
      return {
        stdout: async () => output.stdout,
        stderr: async () => output.stderr,
        wait: async () => ({ exitCode: output.status ?? 1 }),
        kill: async () => {
          /* Synchronous fixture commands have already exited. */
        },
      } as never;
    },
  });
  return { root, repository, metadata, git, manifest, record, native };
};

const freshTemplateFixture = async () => {
  const f = fixture();
  rmSync(path.join(f.metadata, "source-files.json"));
  rmSync(path.join(f.metadata, "source-checksums.sha256"));
  f.git("remote", "add", "origin", ARRUSTED_TEMPLATE_REPOSITORY);
  f.git("update-ref", "refs/remotes/origin/main", f.record.sourceSha);
  const sandbox = createVercelSdkSession(f.native());
  await acquireCanonicalArrustedTemplate({
    sandbox,
    callId: "acquire-fresh-template",
    reader: { acquire: async () => ({ token: "unused-fixture-source-token" }) },
  });
  const record = await readPreparedSandboxWorkspaceRecord(sandbox);
  if (record === undefined) {
    throw new Error("Expected the fresh-template producer's record");
  }
  return { ...f, record };
};

describe("destination review after retained workspace metadata loss", () => {
  it.each(["same-baseline", "new-baseline"])(
    "preserves metadata restored after the initial missing-file read: %s",
    async (winner) => {
      const f = await freshTemplateFixture();
      try {
        const manifestPath = path.join(f.metadata, "source-files.json");
        const checksumsPath = path.join(f.metadata, "source-checksums.sha256");
        // SAFETY: The production manifest generator produced this controlled fixture.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Retain the fixture's known file records to construct the competing preparation.
        const files = JSON.parse(f.manifest) as { path: string; sha256: string }[];
        if (winner === "new-baseline") {
          files[0].sha256 = "f".repeat(64);
        }
        const winningManifest = `${JSON.stringify(files, null, 4)}\n`;
        const checksumLines = files.map((file) => `${file.sha256}  repository/${file.path}`);
        const winningChecksums = [...checksumLines, ""].join("\n");
        rmSync(manifestPath, { force: true });
        rmSync(checksumsPath, { force: true });
        const sandbox = createVercelSdkSession(
          f.native(() => {
            writeFileSync(manifestPath, winningManifest);
            writeFileSync(checksumsPath, winningChecksums);
          }),
        );
        const read = readPreparedSandboxSourceManifest(sandbox, f.record);
        await (winner === "same-baseline"
          ? expect(read).resolves.toHaveLength(5)
          : expect(read).rejects.toThrow("no longer matches its receipt"));
        expect(readFileSync(manifestPath, "utf-8")).toBe(winningManifest);
        expect(readFileSync(checksumsPath, "utf-8")).toBe(winningChecksums);
      } finally {
        rmSync(f.root, { recursive: true, force: true });
      }
    },
  );

  it("does not replace a checksum belonging to another incomplete preparation", async () => {
    const f = fixture();
    try {
      const manifestPath = path.join(f.metadata, "source-files.json");
      const checksumsPath = path.join(f.metadata, "source-checksums.sha256");
      rmSync(manifestPath);
      const competingChecksum = "another preparation's checksums\n";
      const sandbox = createVercelSdkSession(
        f.native(() => {
          writeFileSync(checksumsPath, competingChecksum);
        }),
      );
      await expect(readPreparedSandboxSourceManifest(sandbox, f.record)).rejects.toThrow(
        "app and session are preserved",
      );
      expect(readFileSync(checksumsPath, "utf-8")).toBe(competingChecksum);
      expect(existsSync(manifestPath)).toBe(false);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("restores the original Git baseline through a reattached SDK reader without losing repaired app or registration", async () => {
    const f = await freshTemplateFixture();
    try {
      expect(f.record.workspaceDigest).toBe(
        hash(JSON.stringify({ sourceSha: f.record.sourceSha, sourceTree: f.record.sourceTree })),
      );
      expect(f.record.eligibilityDigest).toBe(f.record.workspaceDigest);
      expect(existsSync(path.join(f.metadata, "source-files.json"))).toBe(false);
      const appDirectory = path.join(f.repository, "apps/example/app");
      mkdirSync(appDirectory, { recursive: true });
      const authored = {
        "apps/example/package.json": '{"name":"example"}',
        "apps/example/app/page.tsx": "initial app page",
        "apps/example/app/actions.ts": "repaired private action",
        "bun.lock": "new app lock",
        "microfrontends.json": '{"applications":{"example":{}}}',
        "package.json": '{"workspaces":["apps/*"]}\n',
      };
      for (const [name, content] of Object.entries(authored)) {
        writeFileSync(path.join(f.repository, name), content);
      }
      const before = f.git("status", "--porcelain=v1");
      // A stopped/rebound provider retains its filesystem and logical identity.
      const resumed = createVercelSdkSession(f.native());
      const files = Object.entries(authored).map(([name, content]) => ({
        path: name,
        digest: hash(content),
        mode: "100644",
      }));
      // SAFETY: The actual candidate-selection helper reads only these supplied
      // fields; workflow approvals and provider writes are outside this fixture.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Supply the fields consumed by the production candidate selector without fabricating approval authority.
      const input = {
        sandbox: resumed,
        observed: { files, treeDigest: "repaired-app" },
        reviewedPaths: ["apps/example/app/actions.ts"],
        state: {
          appSpec: { appId: "example" },
          sourceReceipt: { sourceKind: "fresh-template" },
          workspace: f.record,
          applyReceipt: { targetReceipt: { topology: { path: "microfrontends.json" } } },
        },
      } as never;
      const result = await initialDraftCandidatePaths(input);
      expect(result.candidatePaths.toSorted()).toEqual([
        "apps/example/app/actions.ts",
        "apps/example/app/page.tsx",
        "apps/example/package.json",
        "bun.lock",
        "microfrontends.json",
      ]);
      expect(result.retainedRegistration.get("bun.lock")).toBe(hash("original lock\n"));
      expect(result.retainedRegistration.get("microfrontends.json")).toBe(
        hash('{"applications":{}}\n'),
      );
      expect(JSON.parse(readFileSync(path.join(f.metadata, "source-files.json"), "utf-8"))).toEqual(
        JSON.parse(f.manifest),
      );
      expect(f.git("status", "--porcelain=v1")).toBe(before);
      for (const [name, content] of Object.entries(authored)) {
        expect(readFileSync(path.join(f.repository, name), "utf-8")).toBe(content);
      }
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it.each(["missing-object", "different-baseline"])(
    "preserves the app when original objects cannot prove the saved baseline: %s",
    async (failure) => {
      const f = fixture();
      try {
        const appFile = path.join(f.repository, "unsaved-app.txt");
        writeFileSync(appFile, "preserve these app bytes");
        rmSync(path.join(f.metadata, "source-files.json"));
        await expect(
          readPreparedSandboxSourceManifest(createVercelSdkSession(f.native()), {
            ...f.record,
            ...(failure === "missing-object"
              ? { sourceSha: "a".repeat(40) }
              : { workspaceDigest: "0".repeat(64) }),
          }),
        ).rejects.toThrow("app and session are preserved");
        expect(readFileSync(appFile, "utf-8")).toBe("preserve these app bytes");
        expect(existsSync(path.join(f.metadata, "source-files.json"))).toBe(false);
      } finally {
        rmSync(f.root, { recursive: true, force: true });
      }
    },
  );

  it.each(["sha256", "objectId", "mode", "path", "omitted-file", "checksum"] as const)(
    "checks the exact original Git baseline for an existing source-identity manifest: %s",
    async (changed) => {
      const f = await freshTemplateFixture();
      try {
        const files = z
          .array(
            z.object({
              mode: z.string(),
              objectId: z.string(),
              path: z.string(),
              sha256: z.string(),
            }),
          )
          .parse(JSON.parse(f.manifest));
        const [first] = files;
        if (first === undefined) {
          throw new Error("Expected original fixture files");
        }
        if (changed === "sha256") {
          first.sha256 = "f".repeat(64);
        } else if (changed === "objectId") {
          first.objectId = "f".repeat(40);
        } else if (changed === "mode") {
          first.mode = "100755";
        } else if (changed === "path") {
          first.path = "another-original-file";
        } else if (changed === "omitted-file") {
          files.shift();
        }
        const manifest = JSON.stringify(files);
        const checksums =
          files.map((file) => `${file.sha256}  repository/${file.path}\n`).join("") +
          (changed === "checksum" ? "foreign checksum\n" : "");
        writeFileSync(path.join(f.metadata, "source-files.json"), manifest);
        writeFileSync(path.join(f.metadata, "source-checksums.sha256"), checksums);
        const appFile = path.join(f.repository, "private-app-edit.txt");
        writeFileSync(appFile, "retain private app edit");
        await expect(
          readPreparedSandboxSourceManifest(createVercelSdkSession(f.native()), f.record),
        ).rejects.toThrow("no longer matches its receipt");
        expect(readFileSync(appFile, "utf-8")).toBe("retain private app edit");
        expect(readFileSync(path.join(f.metadata, "source-files.json"), "utf-8")).toBe(manifest);
        expect(readFileSync(path.join(f.metadata, "source-checksums.sha256"), "utf-8")).toBe(
          checksums,
        );
      } finally {
        rmSync(f.root, { recursive: true, force: true });
      }
    },
  );

  it("preserves fresh-template source and receipts when an original Git blob is missing", async () => {
    const f = await freshTemplateFixture();
    try {
      const appFile = path.join(f.repository, "private-app-edit.txt");
      writeFileSync(appFile, "retain private app edit");
      const original = f.git("rev-parse", `${f.record.sourceSha}:shared.txt`);
      rmSync(path.join(f.repository, ".git/objects", original.slice(0, 2), original.slice(2)));
      await expect(
        readPreparedSandboxSourceManifest(createVercelSdkSession(f.native()), f.record),
      ).rejects.toThrow("app and session are preserved");
      expect(readFileSync(appFile, "utf-8")).toBe("retain private app edit");
      expect(existsSync(path.join(f.metadata, "source-files.json"))).toBe(false);
      expect(await readPreparedSandboxWorkspaceRecord(createVercelSdkSession(f.native()))).toEqual(
        f.record,
      );
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("repairs only missing checksums after proving an existing fresh-template manifest", async () => {
    const f = await freshTemplateFixture();
    try {
      writeFileSync(path.join(f.metadata, "source-files.json"), f.manifest);
      const original = f.git("status", "--porcelain=v1");
      await expect(
        readPreparedSandboxSourceManifest(createVercelSdkSession(f.native()), f.record),
      ).resolves.toHaveLength(5);
      expect(readFileSync(path.join(f.metadata, "source-files.json"), "utf-8")).toBe(f.manifest);
      expect(readFileSync(path.join(f.metadata, "source-checksums.sha256"), "utf-8")).toContain(
        "  repository/shared.txt\n",
      );
      expect(f.git("status", "--porcelain=v1")).toBe(original);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("keeps existing full-list receipt verification unchanged", async () => {
    const f = fixture();
    try {
      expect(
        await readPreparedSandboxSourceManifest(createVercelSdkSession(f.native()), f.record),
      ).toHaveLength(5);
      expect(f.record.workspaceDigest).toBe(hash(JSON.stringify(JSON.parse(f.manifest))));
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("cannot reconstruct another session's baseline in the current workspace", async () => {
    const f = fixture();
    try {
      rmSync(path.join(f.metadata, "source-files.json"));
      await expect(
        readPreparedSandboxSourceManifest(createVercelSdkSession(f.native()), {
          ...f.record,
          workspaceId: "another-session",
        }),
      ).rejects.toThrow("different app workspace");
      expect(existsSync(path.join(f.metadata, "source-files.json"))).toBe(false);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
});
