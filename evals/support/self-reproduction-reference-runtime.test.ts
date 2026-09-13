import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import {
  assertExternalReferenceRoot,
  referenceRuntimeEnvironment,
  snapshotReferenceSource,
} from "./self-reproduction-reference-runtime";

it("rejects an in-source runtime", () => {
  expect(() => assertExternalReferenceRoot("/tmp/source", "/tmp/source/runtime")).toThrow();
  expect(() => assertExternalReferenceRoot("/tmp/source", "/tmp/external")).not.toThrow();
});

it("copies live tracked changes without credentials or ignored runtime files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "reference-snapshot-test-"));
  const fixture = `${root}-fixture`;
  try {
    execFileSync("git", ["init", "--quiet", root]);
    await writeFile(path.join(root, "app.ts"), "original");
    execFileSync("git", ["add", "app.ts"], { cwd: root });
    await writeFile(path.join(root, "app.ts"), "live edit");
    await writeFile(path.join(root, ".env.local"), "synthetic-private-value");
    await snapshotReferenceSource(root, fixture);
    expect(await readFile(path.join(fixture, "app.ts"), "utf-8")).toBe("live edit");
    await expect(readFile(path.join(fixture, ".env.local"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    await rm(root, { force: true, recursive: true });
    await rm(fixture, { force: true, recursive: true });
  }
});

it("retains tool and PostgreSQL lookup while excluding hosted identity and preload inheritance", () => {
  const parent = {
    CI: "1",
    DATABASE_URL: "live-database",
    GITHUB_TOKEN: "live-github",
    HOME: "/home/sandbox",
    LANG: "C.UTF-8",
    LD_PRELOAD: "/tmp/loader.so",
    NODE_OPTIONS: "--import=/tmp/live-preload.mjs",
    PATH: "/usr/lib/postgresql/16/bin:/workspace/toolchain/bin:/usr/bin",
    SELF_REPRODUCTION_WORKLOAD_IDENTITY_FILE: "/tmp/live-identity.json",
    TMPDIR: "/tmp",
    VERCEL: "1",
    VERCEL_ENV: "production",
    VERCEL_OIDC_TOKEN: "live-token",
    VERCEL_PROJECT_ID: "live-project",
    VERCEL_TARGET_ENV: "production",
  };
  const result = referenceRuntimeEnvironment("/workspace/toolchain/bin/mise", parent);
  expect(result).toEqual({
    CI: "1",
    HOME: "/home/sandbox",
    LANG: "C.UTF-8",
    MISE_BIN_PATH: "/workspace/toolchain/bin/mise",
    NEXT_TELEMETRY_DISABLED: "1",
    PATH: "/workspace/toolchain/bin:/usr/lib/postgresql/16/bin:/workspace/toolchain/bin:/usr/bin",
    TMPDIR: "/tmp",
  });
  expect(parent.VERCEL_OIDC_TOKEN).toBe("live-token");
});
