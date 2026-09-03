import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execute = promisify(execFile);
const readDocumentation = (path: string) => readFile(resolve(path), "utf8");
const verifiedReleaseInstall = {
  path: "docs/installing.md",
  heading: "## Install before shared marketplace publication",
} as const;

function firstShellBlock(documentation: string, heading: string) {
  const section = documentation.slice(documentation.indexOf(heading));
  const match = section.match(/```sh\n([\s\S]*?)\n```/u);
  if (!match) throw new Error(`${heading} has no shell block.`);
  return match[1];
}

async function writeStub(root: string, name: string, body: string) {
  await writeFile(join(root, name), `#!/bin/sh\nset -eu\n${body}\n`, {
    mode: 0o700,
  });
}

async function readAuditLog(path: string) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

async function runInstall(
  script: string,
  failure: "none" | "checksum" | "release-verifier",
) {
  const root = await mkdtemp(join(tmpdir(), "autograph-install-docs-"));
  const bin = join(root, "bin");
  const auditLog = join(root, "audit.log");
  await mkdir(bin);
  await writeStub(
    bin,
    "gh",
    'case "${2:-}" in download) exit 0 ;; verify) exit "${GH_VERIFY_EXIT:-0}" ;; verify-asset) exit 0 ;; *) exit 2 ;; esac',
  );
  await writeStub(bin, "shasum", 'exit "${SHASUM_EXIT:-0}"');
  await writeStub(bin, "tar", 'printf "tar %s\\n" "$*" >> "$AUDIT_LOG"');
  await writeStub(bin, "codex", 'printf "codex %s\\n" "$*" >> "$AUDIT_LOG"');

  const execution = execute("/bin/sh", ["-c", script], {
    cwd: root,
    env: {
      NODE_ENV: "test",
      PATH: `${bin}:/usr/bin:/bin`,
      AUDIT_LOG: auditLog,
      SHASUM_EXIT: failure === "checksum" ? "1" : "0",
      GH_VERIFY_EXIT: failure === "release-verifier" ? "1" : "0",
    },
  });
  try {
    if (failure === "none") await execution;
    else await expect(execution).rejects.toThrow();
    return await readAuditLog(auditLog);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("public plugin installation documentation", () => {
  it("stops before extraction or installation when release verification fails", async () => {
    const { path, heading } = verifiedReleaseInstall;
    const documentation = await readDocumentation(path);
    const script = firstShellBlock(documentation, heading);
    expect(script).toContain("set -eu");

    for (const failure of ["checksum", "release-verifier"] as const) {
      const auditLog = await runInstall(script, failure);
      expect(auditLog).toBe("");
      expect(auditLog).not.toContain("tar ");
      expect(auditLog).not.toContain("codex plugin marketplace add");
      expect(auditLog).not.toContain("codex plugin add");
    }

    const auditLog = await runInstall(script, "none");
    expect(auditLog).toContain(
      "tar -xzf app-builder-codex-marketplace-0.2.7.tar.gz",
    );
    expect(auditLog).toMatch(
      /codex plugin marketplace add .*app-builder-marketplace-0\.2\.7/u,
    );
    expect(auditLog).toContain("codex plugin add app-builder@autograph");
  });

  it("uses the shared marketplace as the primary README installation path", async () => {
    const documentation = await readDocumentation("README.md");
    const script = firstShellBlock(documentation, "## Install");

    expect(script).toContain(
      "codex plugin marketplace add withAutograph/marketplace",
    );
    expect(script).toContain("codex plugin add app-builder@autograph");
    expect(script).not.toContain("gh release download");
    expect(script).not.toContain("tar -xzf");
  });

  it("keeps exact pre-release assets and availability explicit", async () => {
    const documentation = await readDocumentation("docs/installing.md");

    expect(documentation).toContain(
      "Once the pre-release `v0.2.7` GitHub release is published",
    );
    expect(documentation).toMatch(
      /These\s+commands fail closed until `v0\.2\.7` exists/u,
    );
    expect(documentation).toContain("app-builder-0.2.7.tar.gz");
    expect(documentation).toContain(
      "app-builder-codex-marketplace-0.2.7.tar.gz",
    );
    expect(documentation).toContain("Exact-main CI waits for Vercel Git");
    expect(documentation).toMatch(
      /The protected\s+`release:publish` step creates the prerelease/u,
    );
    expect(documentation).toMatch(
      /It never rebuilds, invokes Vercel CLI, pushes an image, or\s+accepts replacement bytes or bindings\./u,
    );
    expect(documentation).not.toContain("owner-only-hosted-oauth-token");
  });
});
