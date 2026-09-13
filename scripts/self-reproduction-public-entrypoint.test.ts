import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

const task = path.resolve(import.meta.dirname, "../.config/mise/tasks/eval/self-reproduction");
const invoke = (args: string[]) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "self-reproduction-entrypoint-"));
  const log = path.join(directory, "calls");
  try {
    writeFileSync(log, "");
    mkdirSync(path.join(directory, ".config/mise/scripts"), { recursive: true });
    writeFileSync(
      path.join(directory, "mise"),
      `#!/bin/sh
printf 'mise %s\\n' "$*" >> "$ENTRYPOINT_TEST_LOG"
if [ "$1" = which ] && [ "$2" = node ]; then printf '/usr/bin/node\\n'; fi
`,
      { mode: 0o700 },
    );
    writeFileSync(
      path.join(directory, ".config/mise/scripts/trusted-node-launcher"),
      `#!/bin/sh
printf 'launcher %s\\n' "$*" >> "$ENTRYPOINT_TEST_LOG"
`,
      { mode: 0o700 },
    );
    const result = spawnSync("/bin/sh", [task, ...args], {
      cwd: directory,
      encoding: "utf-8",
      env: {
        ENTRYPOINT_TEST_LOG: log,
        NODE_ENV: "test",
        PATH: `${directory}:/usr/bin:/bin`,
      },
    });
    return { calls: readFileSync(log, "utf-8"), ...result };
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
};

it.each([
  [],
  ["--live-model"],
  ["--arrusted-root", "/tmp/template", "--output-dir", "/tmp/evidence"],
  ["--candidate-runtime"],
  ["--reference-runtime", "--reference-navigation"],
])("rejects generation invocation %j before setup or launcher execution", (...args) => {
  const result = invoke(args);
  expect(result.status, result.stderr).toBe(64);
  expect(result.stderr).toContain("guided internal generation is retired");
  expect(result.calls).toBe("");
});

it.each(["--help", "-h"])("shows %s without resolving tools or refreshing identity", (help) => {
  const result = invoke(["--candidate-runtime", help]);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("autograph_start");
  expect(result.calls).toBe("");
});

it("runs report-only comparison without an OIDC refresh", () => {
  const result = invoke(["--report-only", "--candidate-root", "/tmp/candidate"]);
  expect(result.status, result.stderr).toBe(0);
  expect(result.calls).toContain("mise which node");
  expect(result.calls).toContain("scripts/eval-self-reproduction.mts");
  expect(result.calls).toContain("--report-only --candidate-root /tmp/candidate");
  expect(result.calls).not.toContain("local:ensure-oidc");
  expect(result.calls).not.toContain("reconcile");
});

it("refreshes project OIDC only for explicitly requested candidate runtime comparison", () => {
  const result = invoke(["--report-only", "--candidate-runtime"]);
  expect(result.status, result.stderr).toBe(0);
  expect(result.calls.split("\n")[0]).toBe("mise run local:ensure-oidc");
  expect(result.calls).toContain("--report-only --candidate-runtime");
});

it("launches only the public driver without provisioning infrastructure", () => {
  const result = invoke([
    "--endpoint",
    "http://127.0.0.1:64613/mcp",
    "--output-dir",
    "/tmp/evidence",
  ]);
  expect(result.status, result.stderr).toBe(0);
  expect(result.calls).toContain("scripts/self-reproduction-public.mts");
  expect(result.calls).not.toContain("scripts/eval-self-reproduction.mts");
  expect(result.calls).not.toContain("local:ensure-oidc");
});

it("rejects ambiguous public-driving and comparison modes", () => {
  const result = invoke(["--endpoint", "http://127.0.0.1:64613/mcp", "--report-only"]);
  expect(result.status).toBe(64);
  expect(result.calls).toBe("");
});
