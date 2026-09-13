import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function createTaskFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "hosted-artifact-task-"));
  const bin = path.join(root, "bin");
  const launcher = path.join(root, ".config/mise/scripts/trusted-node-launcher");
  const calls = path.join(root, "mise-calls");
  mkdirSync(bin, { recursive: true });
  mkdirSync(path.join(root, ".config/mise/scripts"), { recursive: true });
  writeFileSync(launcher, "#!/bin/sh\nexit 0\n");
  chmodSync(launcher, 0o700);
  writeFileSync(
    path.join(bin, "mise"),
    `#!/bin/sh
set -eu
if [ "$#" -eq 2 ] && [ "$1" = "which" ] && [ "$2" = "node" ]; then
  printf '%s\\n' /usr/bin/node
  exit 0
fi
printf '%s\\n' CALL >> "$MISE_CALLS"
printf '%s\\n' "$@" >> "$MISE_CALLS"
`,
  );
  chmodSync(path.join(bin, "mise"), 0o700);
  return {
    calls,
    environment: {
      LANG: "C",
      MISE_CALLS: calls,
      NODE_ENV: "test" as const,
      PATH: `${bin}:/usr/bin:/bin`,
    },
    root,
  };
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function readCalls(callsFile: string) {
  return readFileSync(callsFile, "utf-8").trim().split("\n");
}

describe("hosted artifact mise task contract", () => {
  it("forwards exact artifact proof inputs from the hosted sandbox test", () => {
    const fixture = createTaskFixture();
    const args = [
      "--arrusted-root",
      "/fixture/arrusted",
      "--artifact",
      "/fixture/dependencies.tar.gz",
      "--artifact-sha256",
      "a".repeat(64),
    ];
    try {
      const result = spawnSync(
        path.join(repositoryRoot, ".config/mise/tasks/test/hosted-sandbox"),
        args,
        {
          cwd: fixture.root,
          encoding: "utf-8",
          env: fixture.environment,
        },
      );

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(readCalls(fixture.calls)).toEqual([
        "CALL",
        "run",
        "hosted:artifact-prove",
        "--",
        ...args,
      ]);
    } finally {
      rmSync(fixture.root, { force: true, recursive: true });
    }
  });

  it("maps the typed source root and forwards the artifact binding", () => {
    const fixture = createTaskFixture();
    try {
      const result = spawnSync(
        path.join(repositoryRoot, ".config/mise/tasks/hosted/artifact-prove-typed"),
        [
          "--image",
          "example.invalid/eve@sha256:digest",
          "--source-root",
          "/fixture/arrusted",
          "--artifact",
          "/fixture/dependencies.tar.gz",
          "--artifact-sha256",
          "b".repeat(64),
        ],
        {
          cwd: fixture.root,
          encoding: "utf-8",
          env: fixture.environment,
        },
      );

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(readCalls(fixture.calls)).toEqual([
        "CALL",
        "run",
        "hosted:artifact-prove",
        "--",
        "--arrusted-root",
        "/fixture/arrusted",
        "--artifact",
        "/fixture/dependencies.tar.gz",
        "--artifact-sha256",
        "b".repeat(64),
      ]);
    } finally {
      rmSync(fixture.root, { force: true, recursive: true });
    }
  });

  it("rejects omitted proof bindings before running either workflow", () => {
    const fixture = createTaskFixture();
    try {
      for (const task of [
        ".config/mise/tasks/test/hosted-sandbox",
        ".config/mise/tasks/hosted/artifact-prove-typed",
      ]) {
        const result = spawnSync(path.join(repositoryRoot, task), [], {
          cwd: fixture.root,
          encoding: "utf-8",
          env: fixture.environment,
        });
        expect(result.status).toBe(64);
        expect(result.stderr).toContain("--artifact-sha256 <sha256>");
      }
    } finally {
      rmSync(fixture.root, { force: true, recursive: true });
    }
  });
});
