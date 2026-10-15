/* oxlint-disable eslint/require-await, typescript/no-non-null-assertion, anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion, typescript/no-unsafe-type-assertion -- Synthetic SDK fixtures expose only the proposal methods exercised here; all non-null file reads follow asserted successful proposal creation. */
import { describe, expect, it, vi } from "vitest";
import { createHostedOperatorAuthProposal } from "./hosted-operator-auth-proposal";
import type { HostedOperatorSourceConfiguration } from "./hosted-operator-source-configuration";
import type { Sandbox } from "@vercel/sandbox";

const resource = {
  version: 1,
  environment: "preview",
  hostname: "ep-owned.neon.tech",
  port: 5432,
  database: "owned_auth",
  schema: "public",
  runtimeRole: "auth_runtime",
  migratorRole: "auth_migrator",
  neon: { branchId: "br-owned", projectId: "project-owned" },
} as const;
const migrationUrl =
  "postgresql://auth_migrator:private-fixture@ep-owned.neon.tech/owned_auth?sslmode=verify-full";
const digest = "a".repeat(64);
const configuration = {
  catalogAppIds: ["spend-review"],
  sandbox: {
    authProposal: { executablePath: "/proposal", id: "proposal", sha256: digest },
    projectId: "owned-project",
    teamId: "owned-team",
    source: { snapshotId: "owned-snapshot", type: "snapshot" },
  },
} as HostedOperatorSourceConfiguration;
const fixture = (existing = true) => {
  const frame = {
    version: 1,
    resource,
    schemaPlan: { planDigest: "b".repeat(64), targetDigest: "c".repeat(64) },
    ...(existing ? {} : { proposal: "new-empty" }),
  };
  const sandbox = {
    delete: vi.fn(async () => {}),
    writeFiles: vi.fn<Pick<Sandbox, "writeFiles">["writeFiles"]>(async () => {}),
    runCommand: vi.fn(async ({ cmd }: { cmd: string }) => ({
      exitCode: 0,
      stdout: async () => (cmd === "sha256sum" ? `${digest}  /proposal\n` : JSON.stringify(frame)),
    })),
  } as unknown as Pick<Sandbox, "delete" | "writeFiles" | "runCommand">;
  const createSandbox = vi.fn(async (_options: Parameters<typeof Sandbox.create>[0]) => sandbox);
  const getOidc = vi.fn(async () => "owned-oidc");
  const assertCurrentOwner = vi.fn(async () => {});
  return {
    sandbox,
    createSandbox,
    getOidc,
    assertCurrentOwner,
    propose: createHostedOperatorAuthProposal(configuration, { createSandbox, getOidc }),
  };
};
describe("private existing Auth proposal", () => {
  it("places the scoped credential in a separate 0600 file and publishes only the observed plan", async () => {
    const f = fixture();
    const result = await f.propose({
      resource,
      directMigrationUrl: migrationUrl,
      assertCurrentOwner: f.assertCurrentOwner,
    });
    expect(result.planDigest).toBe("b".repeat(64));
    expect(result.content.toString()).not.toContain("private-fixture");
    const files = vi.mocked(f.sandbox.writeFiles).mock.calls[0]?.[0] ?? [];
    const credential = files.find((file) => file.content.toString() === migrationUrl);
    expect(credential?.mode).toBe(0o600);
    const input = files.find((file) => file !== credential);
    expect(input?.mode).toBe(0o600);
    expect(JSON.parse(input!.content.toString())).toMatchObject({
      resource,
      directMigrationUrlFile: credential?.path,
    });
    expect(input!.content.toString()).not.toContain(migrationUrl);
    expect(JSON.stringify(vi.mocked(f.sandbox.runCommand).mock.calls)).not.toContain(migrationUrl);
    expect(f.createSandbox.mock.calls[0]?.[0]).toMatchObject({
      env: {},
      networkPolicy: "allow-all",
      projectId: "owned-project",
    });
    expect(f.getOidc).toHaveBeenCalledWith({ project: "owned-project", team: "owned-team" });
    expect(f.assertCurrentOwner).toHaveBeenCalled();
    expect(f.sandbox.delete).toHaveBeenCalledOnce();
  });
  it("keeps new targets credential free", async () => {
    const f = fixture(false);
    const result = await f.propose({ resource, assertCurrentOwner: f.assertCurrentOwner });
    expect(result.content.toString()).toContain('"proposal":"new-empty"');
    expect(vi.mocked(f.sandbox.writeFiles).mock.calls[0]?.[0]).toHaveLength(1);
  });
  it.each([
    migrationUrl.replace("owned_auth", "foreign_auth"),
    migrationUrl.replace("auth_migrator", "auth_runtime"),
    migrationUrl.replace("ep-owned.", "ep-foreign."),
    migrationUrl.replace("ep-owned.", "ep-owned-pooler."),
    `${migrationUrl}&host=foreign`,
    migrationUrl.replace("verify-full", "require"),
  ])(
    "rejects an invalid resource credential before creating a sandbox",
    async (directMigrationUrl) => {
      const f = fixture();
      await expect(
        f.propose({ resource, directMigrationUrl, assertCurrentOwner: f.assertCurrentOwner }),
      ).rejects.toMatchObject({ code: "resource_mismatch" });
      expect(f.createSandbox).not.toHaveBeenCalled();
    },
  );
  it("does not use a new-empty artifact for an existing target", async () => {
    const f = fixture(false);
    await expect(
      f.propose({
        resource,
        directMigrationUrl: migrationUrl,
        assertCurrentOwner: f.assertCurrentOwner,
      }),
    ).rejects.toMatchObject({ code: "resource_mismatch" });
    expect(f.sandbox.delete).toHaveBeenCalledOnce();
  });
  it("stops on lost owner authority and still deletes the sandbox", async () => {
    const f = fixture();
    f.assertCurrentOwner
      .mockImplementationOnce(() => Promise.resolve())
      .mockRejectedValueOnce(new Error("ownership lost"));
    await expect(
      f.propose({
        resource,
        directMigrationUrl: migrationUrl,
        assertCurrentOwner: f.assertCurrentOwner,
      }),
    ).rejects.toThrow("ownership lost");
    expect(f.sandbox.writeFiles).not.toHaveBeenCalled();
    expect(f.sandbox.delete).toHaveBeenCalledOnce();
  });
});
