import { applicationImportBaselineSnapshot } from "./target-apply";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { SandboxSession } from "eve/sandbox";
import { planApplicationSourceRegistration } from "./application-source-registration";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
describe("imported application registration planning", () => {
  it("uses only the acquired platform pure planner without executing app source", async () => {
    const proposedBytes = '{"applications":{"invoice-app":{}}}';
    const run = vi.fn<SandboxSession["run"]>().mockResolvedValue({
      exitCode: 0,
      stderr: "",
      stdout: JSON.stringify({
        assetRoute: "/asset/:path*",
        newDigest: digest(proposedBytes),
        oldDigest: "a".repeat(64),
        projectName: "invoice-app",
        proposedBytes,
      }),
    });
    // SAFETY: The planner only invokes run; fixtures never exercise dependency recovery.
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- Deliberately bounded Sandbox fixture.
    const sandbox = { run } as unknown as SandboxSession;
    const result = await planApplicationSourceRegistration(sandbox, "invoice-app");
    expect(result.newDigest).toBe(digest(proposedBytes));
    expect(run.mock.calls[0]?.[0].command).toContain(
      "packages/platform-microfrontends/src/policy/config-registration.ts",
    );
    expect(run.mock.calls[0]?.[0].command).not.toContain("apps/invoice-app/");
  });
  it("rejects substituted registration output and invalid app identities", async () => {
    const run = vi.fn<SandboxSession["run"]>().mockResolvedValue({
      exitCode: 0,
      stderr: "",
      stdout: JSON.stringify({
        assetRoute: "/asset/:path*",
        newDigest: "b".repeat(64),
        oldDigest: "a".repeat(64),
        projectName: "other-app",
        proposedBytes: "{}",
      }),
    });
    // SAFETY: The planner only invokes run; fixtures never exercise dependency recovery.
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- Deliberately bounded Sandbox fixture.
    const sandbox = { run } as unknown as SandboxSession;
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
    files: [
      { digest: "a".repeat(64), mode: "100644", path: "apps/invoice-app/public/data.bin" },
      { digest: "b".repeat(64), mode: "100644", path: "apps/other-app/keep.ts" },
      { digest: "c".repeat(64), mode: "100644", path: "microfrontends.json" },
    ],
    treeDigest: "prior",
  };
  const baseline = applicationImportBaselineSnapshot(snapshot, "apps/invoice-app");
  expect(baseline.files.map((file) => file.path)).toEqual([
    "apps/other-app/keep.ts",
    "microfrontends.json",
  ]);
  expect(snapshot.files).toHaveLength(3);
});
