import { applicationImportBaselineSnapshot } from "./target-apply";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { SandboxSession } from "eve/sandbox";
import { planApplicationSourceRegistration } from "./application-source-registration";

const unexpectedSandboxOperation = (): never => {
  throw new Error("Unexpected sandbox operation in test fixture");
};
const createSandbox = (run: SandboxSession["run"]): SandboxSession => ({
  readBinaryFile: unexpectedSandboxOperation,
  readFile: unexpectedSandboxOperation,
  readTextFile: unexpectedSandboxOperation,
  removePath: unexpectedSandboxOperation,
  resolvePath: unexpectedSandboxOperation,
  run,
  spawn: unexpectedSandboxOperation,
  writeBinaryFile: unexpectedSandboxOperation,
  writeFile: unexpectedSandboxOperation,
  writeTextFile: unexpectedSandboxOperation,
});

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
describe("imported application registration planning", () => {
  it("uses only the acquired platform pure planner without executing app source", async () => {
    const proposedBytes = '{"applications":{"invoice-app":{}}}';
    const run = vi.fn<SandboxSession["run"]>(() =>
      Promise.resolve({
        exitCode: 0,
        stdout: JSON.stringify({
          oldDigest: "a".repeat(64),
          newDigest: digest(proposedBytes),
          proposedBytes,
          projectName: "invoice-app",
          assetRoute: "/asset/:path*",
        }),
        stderr: "",
      }),
    );
    const sandbox = createSandbox(run);
    const result = await planApplicationSourceRegistration(sandbox, "invoice-app");
    expect(result.newDigest).toBe(digest(proposedBytes));
    expect(run.mock.calls[0]?.[0].command).toContain(
      "packages/platform-microfrontends/src/policy/config-registration.ts",
    );
    expect(run.mock.calls[0]?.[0].command).not.toContain("apps/invoice-app/");
  });
  it("rejects substituted registration output and invalid app identities", async () => {
    const run = vi.fn<SandboxSession["run"]>(() =>
      Promise.resolve({
        exitCode: 0,
        stdout: JSON.stringify({
          oldDigest: "a".repeat(64),
          newDigest: "b".repeat(64),
          proposedBytes: "{}",
          projectName: "other-app",
          assetRoute: "/asset/:path*",
        }),
        stderr: "",
      }),
    );
    const sandbox = createSandbox(run);
    await expect(planApplicationSourceRegistration(sandbox, "invoice-app")).rejects.toThrow(
      "plan mismatch",
    );
    await expect(planApplicationSourceRegistration(sandbox, "../../other")).rejects.toThrow(
      "identity",
    );
  });
});

it("reviews every imported app file against its absent acquired-platform base", () => {
  const snapshot = {
    treeDigest: "prior",
    files: [
      { path: "apps/invoice-app/public/data.bin", digest: "a".repeat(64), mode: "100644" },
      { path: "apps/other-app/keep.ts", digest: "b".repeat(64), mode: "100644" },
      { path: "microfrontends.json", digest: "c".repeat(64), mode: "100644" },
    ],
  };
  const baseline = applicationImportBaselineSnapshot(snapshot, "apps/invoice-app");
  expect(baseline.files.map((file) => file.path)).toEqual([
    "apps/other-app/keep.ts",
    "microfrontends.json",
  ]);
  expect(snapshot.files).toHaveLength(3);
});
