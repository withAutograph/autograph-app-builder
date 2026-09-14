import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { workingPreviewSupervisorSource } from "./working-preview-runtime";
import { previewOwnershipRoot, previewOwnershipSource } from "./working-preview-ownership";

const execute = promisify(execFile);
interface OwnershipOperation {
  attempt?: { attemptId?: string; expiresAt?: number; providerSessionId?: string; status?: string };
  attemptId?: string;
  kind: string;
  patch?: { status: string };
  providerSessionId?: string;
}
describe("sandbox preview ownership journal", () => {
  it("claims exclusively across processes and fences stale attempts", async () => {
    const directory = await mkdtemp(nodePath.join(tmpdir(), "preview-owner-"));
    const source = previewOwnershipSource.replace(
      JSON.stringify(previewOwnershipRoot),
      JSON.stringify(directory),
    );
    const run = async (operation: OwnershipOperation) => {
      const result = await execute(process.execPath, [
        "--input-type=module",
        "-e",
        `${source}\nconsole.log(JSON.stringify(await ownershipOperation(${JSON.stringify(operation)})));`,
      ]);
      return JSON.parse(result.stdout) as {
        claimed?: boolean;
        attempt?: { attemptId: string };
        status?: string;
      };
    };
    const identity = { attemptId: "first", providerSessionId: "provider" };
    const attempt = { ...identity, expiresAt: Date.now() + 60_000, status: "starting" };
    try {
      const claims = await Promise.all([
        run({ attempt, kind: "claim" }),
        run({ attempt: { ...attempt, attemptId: "second" }, kind: "claim" }),
      ]);
      expect(claims.filter((claim) => claim.claimed)).toHaveLength(1);
      const winner = claims.find((claim) => claim.claimed)?.attempt?.attemptId;
      const owner = { ...identity, attemptId: winner };
      await expect(run({ kind: "assert", ...owner })).resolves.toMatchObject({
        status: "starting",
      });
      await expect(run({ kind: "assert", ...identity, attemptId: "stale" })).rejects.toThrow(
        "ownership changed",
      );
      await run({ kind: "update", ...owner, patch: { status: "cleanup-required" } });
      await expect(run({ kind: "assert", ...owner })).rejects.toThrow("requires cleanup");
      await expect(
        execute(process.execPath, [
          "--input-type=module",
          "-e",
          `${source} const crash = ownershipOpen(); crash.exec("BEGIN IMMEDIATE"); crash.exec("DELETE FROM attempt"); process.kill(process.pid, "SIGKILL");`,
        ]),
      ).rejects.toThrow();
      await expect(run({ kind: "read" })).resolves.toMatchObject({ status: "cleanup-required" });
      await expect(run({ kind: "update", ...owner, patch: { status: "ready" } })).rejects.toThrow(
        "ready result",
      );
      await run({ kind: "release", ...owner });
      const next = await run({ attempt, kind: "claim" });
      expect(next.claimed).toBe(true);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});

it("rejects a stale supervisor before evaluating its listener source", async () => {
  const directory = await mkdtemp(nodePath.join(tmpdir(), "preview-stale-supervisor-"));
  const owner = {
    attemptId: "current",
    expiresAt: Date.now() + 60_000,
    providerSessionId: "provider",
    status: "starting" as const,
  };
  try {
    const journal = previewOwnershipSource.replace(
      JSON.stringify(previewOwnershipRoot),
      JSON.stringify(directory),
    );
    await execute(process.execPath, [
      "--input-type=module",
      "-e",
      `${journal} await ownershipOperation({kind:"claim", attempt:${JSON.stringify(owner)}});`,
    ]);
    const source = workingPreviewSupervisorSource({
      command: { args: [], executable: "node" },
      configurationPath: "unused",
      cwd: directory,
      expiresAt: owner.expiresAt,
      failurePath: "unused",
      gatewaySource: 'throw new Error("listener source must not execute")',
      ownership: { ...owner, attemptId: "stale" },
      readyPath: "unused",
    }).replace(JSON.stringify(previewOwnershipRoot), JSON.stringify(directory));
    await expect(execute(process.execPath, ["--input-type=module", "-e", source])).rejects.toThrow(
      "Preview startup ownership changed",
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
