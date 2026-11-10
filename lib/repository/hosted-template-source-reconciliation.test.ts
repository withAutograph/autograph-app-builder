import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SandboxSession } from "eve/sandbox";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  hostedTemplateFoundationProgram,
  readCanonicalTemplateFoundation,
  reconcileHostedTemplateFoundation,
} from "./hosted-template-source-reconciliation";
import { planningSourceReconciliationProgram } from "./planning-source-reconciliation";
import { preparedSourceManifestRecoveryProgram } from "./prepared-source-manifest-recovery";
import {
  ARRUSTED_TEMPLATE_REPOSITORY,
  inspectCanonicalTemplateSnapshotReceipt,
} from "./source-receipt";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const manifestSchema = z.array(
  z.object({ path: z.string(), objectId: z.string(), sha256: z.string() }),
);
const unavailableOperation = (): never => {
  throw new Error("Unexpected sandbox operation");
};
const denied: typeof globalThis.fetch = async () =>
  await Promise.reject(new Error("secret-provider-canary"));
const source = <P extends string>(sourceSha: string, sourceTree: string, sourcePath: P) => {
  const identity = hash(JSON.stringify({ sourceSha, sourceTree }));
  const sourceReceipt = inspectCanonicalTemplateSnapshotReceipt({
    readinessDigest: identity,
    snapshot: { sourceSha, sourceTree, sourcePath, contents: {}, contract: [], dirtyPaths: [] },
  });
  return {
    sourceReceipt,
    workspace: {
      adapter: "arrusted-development-v0" as const,
      sourceSha,
      sourceTree,
      sourcePath,
      workspacePath: sourcePath,
      workspaceId: "owned-sandbox",
      eligibilityDigest: identity,
      workspaceDigest: identity,
    },
  };
};

const fixture = () => {
  const temporary = realpathSync(mkdtempSync(path.join(tmpdir(), "hosted-foundation-")));
  const root = path.join(temporary, "repository");
  const metadataRoot = path.join(temporary, ".app-builder");
  mkdirSync(root);
  mkdirSync(metadataRoot);
  const git = (...args: string[]) =>
    execFileSync(
      "/usr/bin/git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "commit.gpgsign=false",
        "-C",
        root,
        ...args,
      ],
      { encoding: "utf-8" },
    ).trim();
  const write = (name: string, bytes: string) => {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writeFileSync(path.join(root, name), bytes);
  };
  git("init", "--quiet");
  git("config", "user.name", "Foundation Fixture");
  git("config", "user.email", "fixture@example.test");
  write(".gitignore", ".data/\n");
  write("package.json", '{"name":"fixture","workspaces":[]}\n');
  write("bun.lock", "workspace: []\n");
  write("microfrontends.json", '{"applications":{}}\n');
  const task = ".config/mise/scripts/repository/app-runtime.cjs";
  write(
    task,
    'const roles=JSON.parse(process.argv[2]); if(roles.length===0) { console.error("Authenticated runtime requires schema-declared roles"); process.exit(1); }\n',
  );
  git("add", ".");
  git("commit", "--quiet", "-m", "old canonical source without the app");
  const old = source(git("rev-parse", "HEAD"), git("rev-parse", "HEAD^{tree}"), root);
  write(
    task,
    'const roles=JSON.parse(process.argv[2]); process.stdout.write(JSON.stringify({roles,environment:"local"}));\n',
  );
  git("add", ".");
  git("commit", "--quiet", "-m", "allow roleless local runtime");
  const next = source(git("rev-parse", "HEAD"), git("rev-parse", "HEAD^{tree}"), root);
  git("checkout", "--quiet", "--detach", old.workspace.sourceSha);
  const app = "synthetic-notes";
  write(`apps/${app}/app/page.tsx`, 'export default function App(){return "accepted app"}\n');
  write(`apps/${app}/schema/app.cue`, "authorization: {roles: []}\n");
  write(`apps/${app}/schema/release/v1/app-artifact.json`, '{"accepted":"release"}\n');
  write(`.config/app-specs/${app}.cue`, 'app: "synthetic-notes"\n');
  write("package.json", '{"name":"fixture","workspaces":["apps/synthetic-notes"]}\n');
  write("bun.lock", "workspace: [synthetic-notes]\n");
  write("microfrontends.json", '{"applications":{"synthetic-notes":{"path":"/notes"}}}\n');
  write(
    ".data/postgres/synthetic-record.json",
    '{"saved":"same record","resource":"same database"}\n',
  );
  writeFileSync(path.join(metadataRoot, "prepared-workspace.json"), JSON.stringify(old.workspace));
  execFileSync(
    process.execPath,
    ["-e", preparedSourceManifestRecoveryProgram, JSON.stringify(old.workspace)],
    { cwd: root },
  );
  const scope = {
    appId: app,
    sessionId: "original-session",
    sourceReceiptDigest: old.sourceReceipt.digest,
    workspace: old.workspace,
  };
  const transitionId = hash(JSON.stringify(scope));
  const transitionRoot = path.join(metadataRoot, "hosted-template-foundations", transitionId);
  const checkpointRef = `refs/app-builder/source-checkpoints/${hash(scope.sessionId)}/${transitionId}`;
  const result = {
    changed: true,
    ...next,
    provenance: {
      previousSourceReceiptDigest: old.sourceReceipt.digest,
      previousWorkspaceDigest: old.workspace.workspaceDigest,
      previousSourceSha: old.workspace.sourceSha,
      sourceSha: next.workspace.sourceSha,
      sourceTree: next.workspace.sourceTree,
      sourceSnapshotTree: next.workspace.sourceTree,
      checkpointRef,
    },
  };
  const journal = { version: 1, scope, callId: "first-recovery", state: "planned", result };
  const request = {
    root,
    metadataRoot,
    transitionRoot,
    repository: ARRUSTED_TEMPLATE_REPOSITORY,
    fetchRemote: false,
    journal,
    reconciliationProgram: planningSourceReconciliationProgram,
    manifestProgram: preparedSourceManifestRecoveryProgram,
  };
  const run = (program = hostedTemplateFoundationProgram) =>
    spawnSync(process.execPath, ["-e", program, JSON.stringify(request)], {
      cwd: root,
      encoding: "utf-8",
    });
  const localTask = () =>
    spawnSync(process.execPath, [path.join(root, task), "[]"], { cwd: root, encoding: "utf-8" });
  const preserved = [
    `apps/${app}/app/page.tsx`,
    `apps/${app}/schema/app.cue`,
    `apps/${app}/schema/release/v1/app-artifact.json`,
    `.config/app-specs/${app}.cue`,
    "package.json",
    "bun.lock",
    "microfrontends.json",
    ".data/postgres/synthetic-record.json",
  ];
  const bytes = () => preserved.map((name) => readFileSync(path.join(root, name), "utf-8"));
  return {
    root,
    metadataRoot,
    transitionRoot,
    old,
    next,
    request,
    checkpointRef,
    run,
    localTask,
    bytes,
    write,
    git,
    dispose: () => {
      rmSync(temporary, { recursive: true, force: true });
    },
  };
};

describe("retained hosted fresh-template foundation", () => {
  it("recovers the stale local command while preserving the same app, registration and saved data", () => {
    const f = fixture();
    try {
      const original = f.bytes();
      expect(f.localTask().status).toBe(1);
      const recovered = f.run();
      expect(recovered.status, recovered.stderr).toBe(0);
      expect(f.localTask().status).toBe(0);
      expect(JSON.parse(f.localTask().stdout)).toEqual({ roles: [], environment: "local" });
      expect(f.bytes()).toEqual(original);
      expect(f.git("show", `${f.checkpointRef}:apps/synthetic-notes/schema/app.cue`)).toBe(
        "authorization: {roles: []}",
      );
      expect(
        JSON.parse(readFileSync(path.join(f.metadataRoot, "prepared-workspace.json"), "utf-8")),
      ).toEqual(f.next.workspace);
      const files = manifestSchema.parse(
        JSON.parse(readFileSync(path.join(f.metadataRoot, "source-files.json"), "utf-8")),
      );
      const registration = files.find((file) => file.path === "microfrontends.json");
      const canonicalPath = `${f.next.workspace.sourceSha}:microfrontends.json`;
      const canonicalRegistration = `${f.git("show", canonicalPath)}\n`;
      expect(registration?.sha256).toBe(hash(canonicalRegistration));
      expect(readFileSync(path.join(f.root, "microfrontends.json"), "utf-8")).not.toBe(
        canonicalRegistration,
      );
    } finally {
      f.dispose();
    }
  });

  it("returns the identical completed transition when the caller still has the original receipt", () => {
    const f = fixture();
    try {
      const original = f.bytes();
      const first = f.run();
      expect(first.status, first.stderr).toBe(0);
      const checkpoint = f.git("rev-parse", f.checkpointRef);
      const second = f.run();
      expect(second.status, second.stderr).toBe(0);
      expect(JSON.parse(second.stdout)).toEqual(JSON.parse(first.stdout));
      expect(JSON.parse(second.stdout)).toMatchObject({
        changed: true,
        provenance: { previousSourceReceiptDigest: f.old.sourceReceipt.digest },
      });
      expect(f.git("rev-parse", f.checkpointRef)).toBe(checkpoint);
      expect(f.bytes()).toEqual(original);
    } finally {
      f.dispose();
    }
  });

  it("resumes after a real metadata write failure without re-creating app or runtime data", () => {
    const f = fixture();
    try {
      const original = f.bytes();
      const record = path.join(f.metadataRoot, "prepared-workspace.json");
      const interrupted = f.run(
        `const fixtureRename=require("node:fs").renameSync; require("node:fs").renameSync=(from,to)=>{if(to===${JSON.stringify(record)}){const failure=Error("fixture disk full");failure.code="ENOSPC";throw failure;} return fixtureRename(from,to);};\n${
          hostedTemplateFoundationProgram
        }`,
      );
      expect(interrupted.status).not.toBe(0);
      expect(f.git("rev-parse", "HEAD")).toBe(f.next.workspace.sourceSha);
      expect(f.bytes()).toEqual(original);
      const resumed = f.run();
      expect(resumed.status, resumed.stderr).toBe(0);
      expect(f.localTask().status).toBe(0);
      expect(f.bytes()).toEqual(original);
    } finally {
      f.dispose();
    }
  });

  it("retains authored shared conflicts and their checkpoint instead of replacing them", () => {
    const f = fixture();
    try {
      const original = f.bytes();
      const authored = 'throw Error("authored tooling change");\n';
      f.write(".config/mise/scripts/repository/app-runtime.cjs", authored);
      expect(f.run().status).not.toBe(0);
      expect(f.git("rev-parse", "HEAD")).toBe(f.old.workspace.sourceSha);
      expect(
        f.git("show", `${f.checkpointRef}:.config/mise/scripts/repository/app-runtime.cjs`),
      ).toBe(authored.trim());
      expect(f.bytes()).toEqual(original);
    } finally {
      f.dispose();
    }
  });

  it("rejects a changed baseline manifest on completed replay", () => {
    const f = fixture();
    try {
      expect(f.run().status).toBe(0);
      const file = path.join(f.metadataRoot, "source-files.json");
      const files = manifestSchema.parse(JSON.parse(readFileSync(file, "utf-8")));
      const [first] = files;
      if (first === undefined) {
        throw new Error("Fixture canonical manifest is empty");
      }
      first.sha256 = "a".repeat(64);
      writeFileSync(file, JSON.stringify(files));
      expect(f.run().status).not.toBe(0);
    } finally {
      f.dispose();
    }
  });
});

describe("hosted foundation owner boundary", () => {
  const input = () => {
    const current = source("a".repeat(40), "b".repeat(40), "/workspace/repository");
    const run = vi.fn();
    const readTextFile = vi.fn(async () => await Promise.resolve(null));
    const sandbox = {
      id: "owned-sandbox",
      run,
      readTextFile,
      readBinaryFile: unavailableOperation,
      readFile: unavailableOperation,
      removePath: unavailableOperation,
      resolvePath: unavailableOperation,
      spawn: unavailableOperation,
      writeBinaryFile: unavailableOperation,
      writeFile: unavailableOperation,
      writeTextFile: unavailableOperation,
    } satisfies SandboxSession & { id: string };
    const reader = {
      acquire: vi.fn(async () => await Promise.resolve({ token: "synthetic-read-token" })),
    };
    const readCanonicalHead = vi.fn(
      async () =>
        await Promise.resolve({
          sourceSha: current.workspace.sourceSha,
          sourceTree: current.workspace.sourceTree,
        }),
    );
    return {
      appId: "synthetic-notes",
      sessionId: "original-session",
      callId: "recovery",
      ...current,
      sandbox,
      reader,
      readCanonicalHead,
      assertCurrent: vi.fn(),
      run,
    };
  };
  it("does not write or retry when the canonical foundation is unchanged", async () => {
    const f = input();
    const result = await reconcileHostedTemplateFoundation(f);
    expect(result).toMatchObject({
      changed: false,
      sourceReceipt: f.sourceReceipt,
      workspace: f.workspace,
    });
    expect(f.run).not.toHaveBeenCalled();
  });
  it("rejects another sandbox before obtaining repository credentials", async () => {
    const f = input();
    f.workspace.workspaceId = "foreign-sandbox";
    await expect(reconcileHostedTemplateFoundation(f)).rejects.toThrow();
    expect(f.reader.acquire).not.toHaveBeenCalled();
    expect(f.run).not.toHaveBeenCalled();
  });
  it("propagates cancellation before any source write", async () => {
    const f = input();
    const abort = new AbortController();
    f.readCanonicalHead.mockImplementationOnce(async () => {
      abort.abort();
      return await Promise.resolve({ sourceSha: "c".repeat(40), sourceTree: "d".repeat(40) });
    });
    await expect(
      reconcileHostedTemplateFoundation({ ...f, signal: abort.signal }),
    ).rejects.toThrow();
    expect(f.run).not.toHaveBeenCalled();
  });
  it("rechecks current ownership after obtaining repository read access", async () => {
    const f = input();
    let current = true;
    f.assertCurrent.mockImplementation(() => {
      if (!current) {
        throw new Error("owner changed");
      }
    });
    f.reader.acquire.mockImplementationOnce(async () => {
      current = false;
      return await Promise.resolve({ token: "synthetic-read-token" });
    });
    await expect(reconcileHostedTemplateFoundation(f)).rejects.toThrow("owner changed");
    expect(f.run).not.toHaveBeenCalled();
  });
  it("keeps transport error bodies private while retaining the original saved scope", async () => {
    const f = input();
    f.readCanonicalHead.mockResolvedValueOnce({
      sourceSha: "c".repeat(40),
      sourceTree: "d".repeat(40),
    });
    f.run.mockRejectedValueOnce(new Error("private-source-token-canary"));
    await expect(reconcileHostedTemplateFoundation(f)).rejects.not.toThrow(
      "private-source-token-canary",
    );
    expect(f.workspace.sourceSha).toBe("a".repeat(40));
  });
  it("reads only canonical main and keeps provider error bodies private", async () => {
    const urls: string[] = [];
    const fetch: typeof globalThis.fetch = async (request) => {
      if (request instanceof Request) {
        urls.push(request.url);
      } else if (request instanceof URL) {
        urls.push(request.href);
      } else {
        urls.push(request);
      }
      return await Promise.resolve(
        Response.json({ sha: "a".repeat(40), commit: { tree: { sha: "b".repeat(40) } } }),
      );
    };
    expect(await readCanonicalTemplateFoundation("synthetic-read-token", fetch)).toEqual({
      sourceSha: "a".repeat(40),
      sourceTree: "b".repeat(40),
    });
    expect(urls).toEqual([
      "https://api.github.com/repos/withAutograph/arrusted-development/commits/main",
    ]);
    await expect(
      readCanonicalTemplateFoundation("synthetic-read-token", denied),
    ).rejects.not.toThrow("secret-provider-canary");
  });
});
