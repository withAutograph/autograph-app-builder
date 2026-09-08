import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");

function createTaskFixture() {
  const root = mkdtempSync(join(tmpdir(), "hosted-artifact-task-"));
  const bin = join(root, "bin");
  const launcher = join(root, ".config/mise/scripts/trusted-node-launcher");
  const calls = join(root, "mise-calls");
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(root, ".config/mise/scripts"), { recursive: true });
  writeFileSync(launcher, "#!/bin/sh\nexit 0\n");
  chmodSync(launcher, 0o700);
  writeFileSync(
    join(bin, "mise"),
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
  chmodSync(join(bin, "mise"), 0o700);
  return {
    root,
    calls,
    environment: {
      LANG: "C",
      MISE_CALLS: calls,
      NODE_ENV: "test" as const,
      PATH: `${bin}:/usr/bin:/bin`,
    },
  };
}

function readCalls(path: string) {
  return readFileSync(path, "utf8").trim().split("\n");
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
        join(repositoryRoot, ".config/mise/tasks/test/hosted-sandbox"),
        args,
        {
          cwd: fixture.root,
          encoding: "utf8",
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
        join(repositoryRoot, ".config/mise/tasks/hosted/artifact-prove-typed"),
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
          encoding: "utf8",
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
        const result = spawnSync(join(repositoryRoot, task), [], {
          cwd: fixture.root,
          encoding: "utf8",
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
