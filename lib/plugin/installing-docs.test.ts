import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const execute = promisify(execFile);
const readDocumentation = (path: string) => readFile(nodePath.resolve(path), "utf-8");
const verifiedReleaseInstall = {
  heading: "## Install before shared marketplace publication",
  path: "docs/installing.md",
} as const;

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function firstShellBlock(documentation: string, heading: string) {
  const section = documentation.slice(documentation.indexOf(heading));
  const match = section.match(/```sh\n(?<shell>[\s\S]*?)\n```/u);
  if (!match) {
    throw new Error(`${heading} has no shell block.`);
  }
  return match[1];
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
async function writeStub(root: string, name: string, body: string) {
  await writeFile(nodePath.join(root, name), `#!/bin/sh\nset -eu\n${body}\n`, {
    mode: 0o700,
  });
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
async function readAuditLog(path: string) {
  try {
    return await readFile(path, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
async function runInstall(script: string, failure: "none" | "checksum" | "release-verifier") {
  const root = await mkdtemp(nodePath.join(tmpdir(), "autograph-install-docs-"));
  const bin = nodePath.join(root, "bin");
  const auditLog = nodePath.join(root, "audit.log");
  await mkdir(bin);
  await writeStub(
    bin,
    "gh",
    `case "\${2:-}" in download) exit 0 ;; verify) exit "\${GH_VERIFY_EXIT:-0}" ;; verify-asset) exit 0 ;; *) exit 2 ;; esac`,
  );
  await writeStub(bin, "shasum", `exit "\${SHASUM_EXIT:-0}"`);
  await writeStub(bin, "tar", 'printf "tar %s\\n" "$*" >> "$AUDIT_LOG"');
  await writeStub(bin, "codex", 'printf "codex %s\\n" "$*" >> "$AUDIT_LOG"');

  const execution = execute("/bin/sh", ["-c", script], {
    cwd: root,
    env: {
      AUDIT_LOG: auditLog,
      GH_VERIFY_EXIT: failure === "release-verifier" ? "1" : "0",
      NODE_ENV: "test",
      PATH: `${bin}:/usr/bin:/bin`,
      SHASUM_EXIT: failure === "checksum" ? "1" : "0",
    },
  });
  try {
    await (failure === "none" ? execution : expect(execution).rejects.toThrow());
    return await readAuditLog(auditLog);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

describe("public plugin installation documentation", () => {
  it("stops before extraction or installation when release verification fails", async () => {
    const { path, heading } = verifiedReleaseInstall;
    const documentation = await readDocumentation(path);
    const script = firstShellBlock(documentation, heading);

    for (const failure of ["checksum", "release-verifier"] as const) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
      const auditLog = await runInstall(script, failure);
      expect(auditLog).toBe("");
      expect(auditLog).not.toContain("tar ");
      expect(auditLog).not.toContain("codex plugin marketplace add");
      expect(auditLog).not.toContain("codex plugin add");
    }

    const { version } = z
      .object({ version: z.string() })
      .parse(JSON.parse(await readDocumentation("package.json")));
    const auditLog = await runInstall(script, "none");
    expect(auditLog).toContain(`tar -xzf app-builder-codex-marketplace-${version}.tar.gz`);
    expect(auditLog).toContain(`app-builder-marketplace-${version}`);
    expect(auditLog).toContain("codex plugin add app-builder@autograph");
  });

  it("installs from the README marketplace commands", async () => {
    const documentation = await readDocumentation("README.md");
    const script = firstShellBlock(documentation, "## Install");
    const auditLog = await runInstall(script, "none");

    expect(auditLog).toContain("codex plugin marketplace add withAutograph/marketplace");
    expect(auditLog).toContain("codex plugin add app-builder@autograph");
  });
});
