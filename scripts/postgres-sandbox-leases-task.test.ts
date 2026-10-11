import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const digest = "sha256:48c8ad3a7284b82be4482a52076d47d879fd6fb084a1cbfccbd551f9331b0e40";
const primaryImage = `public.ecr.aws/docker/library/postgres@${digest}`;
const fallbackImage = `docker.io/library/postgres@${digest}`;
const task = path.resolve(
  import.meta.dirname,
  "../.config/mise/tasks/test/postgres-sandbox-leases",
);

const runTask = (extraEnv: Record<string, string> = {}) => {
  const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), "postgres-sandbox-leases-")));
  const mise = path.join(directory, "mise");
  const docker = path.join(directory, "docker");
  const callsFile = path.join(directory, "calls");
  const launcher = path.join(directory, ".config/mise/scripts/trusted-node-launcher");
  mkdirSync(path.dirname(launcher), { recursive: true });
  writeFileSync(launcher, `#!/bin/sh\nprintf 'proof %s\\n' "$*" >> "$DOCKER_TEST_CALLS"\n`, {
    mode: 0o700,
  });
  writeFileSync(
    mise,
    `#!/bin/sh
test "$1" = which || exit 2
case "$2" in
  docker) printf '%s\\n' "$DOCKER_TEST_BIN" ;;
  node) printf '%s\\n' /usr/bin/true ;;
  *) exit 2 ;;
esac
`,
    { mode: 0o700 },
  );
  writeFileSync(
    docker,
    `#!/bin/sh
printf '%s\\n' "$*" >> "$DOCKER_TEST_CALLS"
case "$1:$2" in
  image:inspect) test "$CACHE_PRIMARY" = 1 ;;
  pull:*)
    case "$2" in
      ${primaryImage}) test "$ECR_PULL_FAIL" != 1 ;;
      ${fallbackImage}) test "$HUB_PULL_FAIL" != 1 ;;
      *) exit 3 ;;
    esac
    ;;
  run:--rm) test "$RUN_FAIL" != 1 || exit 42 ;;
  exec:*) exit 0 ;;
  port:*) printf '%s\\n' '127.0.0.1:15432' ;;
  rm:-f) exit 0 ;;
  *) exit 3 ;;
esac
`,
    { mode: 0o700 },
  );

  try {
    const result = spawnSync("/bin/sh", [task], {
      cwd: directory,
      encoding: "utf-8",
      env: {
        ...process.env,
        CACHE_PRIMARY: "0",
        DOCKER_TEST_BIN: docker,
        DOCKER_TEST_CALLS: callsFile,
        ECR_PULL_FAIL: "0",
        HUB_PULL_FAIL: "0",
        MISE_BIN_PATH: mise,
        PATH: `${directory}:/usr/bin:/bin`,
        RUN_FAIL: "0",
        ...extraEnv,
      },
      timeout: 10_000,
    });
    return {
      calls: readFileSync(callsFile, "utf-8").trim().split("\n"),
      status: result.status,
      stderr: result.stderr,
    };
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
};

describe("PostgreSQL sandbox lease registry fallback", () => {
  it("uses the primary pinned image after its pull succeeds", () => {
    const result = runTask();

    expect(result.status).toBe(0);
    expect(result.calls).toContain(`pull ${primaryImage}`);
    expect(result.calls).not.toContain(`pull ${fallbackImage}`);
    expect(result.calls.some((call) => call.startsWith("run --rm --detach --name "))).toBe(true);
    expect(result.calls.find((call) => call.startsWith("run "))).toContain(primaryImage);
    expect(result.calls.filter((call) => call.startsWith("proof "))).toHaveLength(2);
  });

  it("reuses a cached pinned primary image without pulling", () => {
    const result = runTask({ CACHE_PRIMARY: "1" });

    expect(result.status).toBe(0);
    expect(result.calls).toContain(`image inspect ${primaryImage}`);
    expect(result.calls.some((call) => call.startsWith("pull "))).toBe(false);
    expect(result.calls.find((call) => call.startsWith("run "))).toContain(primaryImage);
  });

  it("falls back only to Docker Official postgres at the identical digest", () => {
    const result = runTask({ ECR_PULL_FAIL: "1" });

    expect(result.status).toBe(0);
    expect(result.calls).toContain(`pull ${primaryImage}`);
    expect(result.calls).toContain(`pull ${fallbackImage}`);
    expect(result.calls.find((call) => call.startsWith("run "))).toContain(fallbackImage);
    expect(result.calls.filter((call) => call.startsWith("proof "))).toHaveLength(2);
    expect(result.stderr).toContain("trying the same digest from Docker Hub");
  });

  it("stops before starting a container when both registry pulls fail", () => {
    const result = runTask({ ECR_PULL_FAIL: "1", HUB_PULL_FAIL: "1" });

    expect(result.status).not.toBe(0);
    expect(result.calls).toContain(`pull ${primaryImage}`);
    expect(result.calls).toContain(`pull ${fallbackImage}`);
    expect(result.calls.some((call) => call.startsWith("run "))).toBe(false);
  });

  it("does not retry the image or container after a runtime failure", () => {
    const result = runTask({ RUN_FAIL: "1" });

    expect(result.status).toBe(42);
    expect(result.calls.filter((call) => call.startsWith("pull "))).toEqual([
      `pull ${primaryImage}`,
    ]);
    expect(result.calls.filter((call) => call.startsWith("run "))).toHaveLength(1);
    expect(result.calls.find((call) => call.startsWith("run "))).toContain(primaryImage);
    expect(result.calls.some((call) => call.startsWith("proof "))).toBe(false);
  });
});
