/* oxlint-disable eslint/require-await -- Provider-shaped filesystem ports resolve synchronously in this actual Git fixture. */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type { SandboxSession } from "eve/sandbox";
import { afterEach, expect, it, vi } from "vitest";
import {
  acquireCanonicalArrustedTemplate,
  inspectCanonicalArrustedSandboxWorkspace,
} from "./arrusted-template";
import type { VercelGitSessionSource } from "../sandbox/vercel-session-source";
import { applicationSourceImportProgram } from "./application-source-import";
import { validateApplicationSourceArtifact } from "../handoff/application-source-bytes";

const remote = "https://github.com/withAutograph/arrusted-development.git";
const roots: string[] = [];
const git = (root: string, args: readonly string[]) =>
  execFileSync(
    "/usr/bin/git",
    ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-C", root, ...args],
    { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});
const fixture = (existing?: "main" | "provider-default" | "historical-main") => {
  const root = mkdtempSync(path.join(tmpdir(), "builder-canonical-ref-"));
  roots.push(root);
  const origin = path.join(root, "origin");
  const checkout = path.join(root, "repository");
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  symlinkSync(process.execPath, path.join(bin, "node"));
  execFileSync("/usr/bin/git", ["init", "-q", "--initial-branch=provider-default", origin]);
  git(origin, ["config", "user.name", "Source fixture"]);
  git(origin, ["config", "user.email", "fixture@example.invalid"]);
  mkdirSync(path.join(origin, "packages"));
  writeFileSync(path.join(origin, "packages/platform-sentinel.txt"), "old-default-platform");
  git(origin, ["add", "."]);
  git(origin, ["commit", "-qm", "provider default"]);
  const oldSha = git(origin, ["rev-parse", "HEAD"]);
  git(origin, ["checkout", "-qb", "main"]);
  writeFileSync(path.join(origin, "packages/platform-sentinel.txt"), "selected-current-main");
  git(origin, ["add", "."]);
  git(origin, ["commit", "-qm", "current canonical main"]);
  const mainSha = git(origin, ["rev-parse", "HEAD"]);
  const mainTree = git(origin, ["rev-parse", "HEAD^{tree}"]);
  git(origin, ["checkout", "-q", "provider-default"]);
  const clone = (revision?: string) => {
    execFileSync("/usr/bin/git", [
      "clone",
      "-q",
      ...(revision === undefined ? [] : ["--branch", revision]),
      "--",
      origin,
      checkout,
    ]);
    git(checkout, ["remote", "set-url", "origin", remote]);
  };
  if (existing !== undefined) {
    clone(existing === "provider-default" ? "provider-default" : "main");
    if (existing === "historical-main") {
      git(checkout, ["checkout", "-q", "--detach", oldSha]);
    }
  }
  const writes: string[] = [];
  const commands: string[] = [];
  const materializeGitSource = vi.fn(async (source: VercelGitSessionSource) => {
    clone(source.revision);
  });
  const run = vi.fn(async ({ command }: { command: string }) => {
    commands.push(command);
    const mapped = command
      .replaceAll("/workspace/repository", checkout)
      .replaceAll("/usr/local/bin:/usr/bin:/bin", `${bin}:/usr/bin:/bin`);
    const result = spawnSync("/bin/sh", ["-c", mapped], {
      cwd: root,
      encoding: "utf-8",
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: "/dev/null", NODE_ENV: "test" },
    });
    return {
      exitCode: result.status ?? 1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  });
  const file = (name: string) =>
    path.join(checkout, name.replace(/^\/workspace\/repository\//u, ""));
  const unsupported = async (): Promise<never> => {
    throw new Error("Unused Sandbox port");
  };
  const sandbox: SandboxSession & {
    id: string;
    materializeGitSource: typeof materializeGitSource;
  } = {
    spawn: unsupported,
    readFile: unsupported,
    readBinaryFile: unsupported,
    writeFile: unsupported,
    writeBinaryFile: unsupported,
    removePath: unsupported,
    resolvePath: (value) => value,
    id: "owned-workspace",
    run,
    materializeGitSource,
    readTextFile: async ({ path: name }: { path: string }) => {
      try {
        return readFileSync(file(name), "utf-8");
      } catch {
        return null;
      }
    },
    writeTextFile: async ({ path: name, content }: { path: string; content: string }) => {
      const target = file(name);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, content);
      writes.push(name);
    },
  };
  const acquire = () =>
    acquireCanonicalArrustedTemplate({
      sandbox,
      callId: "fresh-source",
      reader: { acquire: async () => ({ token: "fixture-token-never-retained" }) },
    });
  return {
    root,
    origin,
    checkout,
    oldSha,
    mainSha,
    mainTree,
    sandbox,
    acquire,
    writes,
    commands,
    materializeGitSource,
  };
};
it("selects current main even when the provider default branch differs", async () => {
  const f = fixture();
  const receipt = await f.acquire();
  expect(f.materializeGitSource).toHaveBeenCalledWith({
    revision: "main",
    token: "fixture-token-never-retained",
    url: remote,
  });
  expect(receipt.sourceSha).toBe(f.mainSha);
  expect(receipt.sourceTree).toBe(f.mainTree);
  expect(receipt.sourceSha).not.toBe(f.oldSha);
  expect(f.commands.join("\n")).not.toContain("fixture-token-never-retained");
});
it.each(["provider-default", "historical-main"] as const)(
  "preserves a wrong occupied %s checkout without issuing a new receipt/workspace record",
  async (existing) => {
    const f = fixture(existing);
    const before = git(f.checkout, ["rev-parse", "HEAD"]);
    await expect(f.acquire()).rejects.toThrow("observed origin/main");
    expect(git(f.checkout, ["rev-parse", "HEAD"])).toBe(before);
    expect(f.materializeGitSource).not.toHaveBeenCalled();
    expect(f.writes).toHaveLength(0);
    expect(f.commands.some((command) => /git (?:fetch|reset|rebase|checkout)/u.test(command))).toBe(
      false,
    );
  },
);
it("accepts a genuine preexisting main checkout and leaves its saved receipt frozen after branch-ref movement", async () => {
  const f = fixture("main");
  const receipt = await f.acquire();
  if (receipt.version !== 4) {
    throw new Error("Expected cloned platform receipt.");
  }
  expect(f.materializeGitSource).not.toHaveBeenCalled();
  const frozen = JSON.stringify(receipt);
  git(f.checkout, ["update-ref", "refs/remotes/origin/main", f.oldSha]);
  const beforeCommands = f.commands.length;
  await expect(
    inspectCanonicalArrustedSandboxWorkspace({ sandbox: f.sandbox, receipt }),
  ).resolves.toMatchObject({ sourceSha: f.mainSha, sourceTree: f.mainTree });
  expect(f.commands).toHaveLength(beforeCommands);
  expect(JSON.stringify(receipt)).toBe(frozen);
});
it("imports old app-only bytes onto the selected new platform without replacing its Git/source sentinel", async () => {
  const f = fixture();
  const platform = await f.acquire();
  const appBytes = Buffer.from("app source authored against an older local platform");
  const appPath = "apps/spend/app.ts";
  const validated = validateApplicationSourceArtifact({
    manifest: {
      version: 1,
      kind: "application-source-v1",
      appId: "spend",
      displayName: "Spend",
      sourceSessionId: "old-local-session",
      files: [
        {
          path: appPath,
          mode: "100644",
          sha256: createHash("sha256").update(appBytes).digest("hex"),
          bytes: appBytes.length,
        },
      ],
      omissions: [],
    },
    files: [{ path: appPath, contentBase64: appBytes.toString("base64") }],
  });
  const staging = path.join(f.root, "import");
  mkdirSync(staging);
  const receipt = {
    version: 1 as const,
    kind: "application-source-import-v1" as const,
    reference: {
      kind: "application-source-candidate-v1" as const,
      uploadId: "f60af72a-c4b4-49c8-8b6a-348c111f7829",
      appId: "spend",
      manifestDigest: validated.manifestDigest,
    },
    sourceSessionId: "old-local-session",
    importedSessionId: "fresh-hosted-session",
    platformSourceReceiptDigest: platform.digest,
    workspaceId: "owned-workspace",
    appRoot: "apps/spend",
    importedByCallId: "fresh-import",
  };
  const plan = { receipt, files: validated.artifact.manifest.files, staging };
  writeFileSync(path.join(staging, "plan.json"), JSON.stringify(plan));
  writeFileSync(path.join(staging, "0.base64"), appBytes.toString("base64"));
  const script = path.join(staging, "import.cjs");
  writeFileSync(script, applicationSourceImportProgram({ ...plan, root: f.checkout }));
  execFileSync(process.execPath, [script]);
  expect(readFileSync(path.join(f.checkout, appPath))).toEqual(appBytes);
  expect(readFileSync(path.join(f.checkout, "packages/platform-sentinel.txt"), "utf-8")).toBe(
    "selected-current-main",
  );
  expect(git(f.checkout, ["rev-parse", "HEAD"])).toBe(f.mainSha);
  expect(
    JSON.parse(
      readFileSync(
        path.join(f.checkout, ".app-builder/application-source-import-spend.json"),
        "utf-8",
      ),
    ),
  ).toMatchObject({
    platformSourceReceiptDigest: platform.digest,
    sourceSessionId: "old-local-session",
  });
});
