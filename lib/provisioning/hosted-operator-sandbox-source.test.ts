/* oxlint-disable eslint/require-await, typescript/no-unsafe-type-assertion, anti-slop/require-safety-comment-for-type-assertion -- The proposal fixture supplies only the configuration properties that its real implementation reads; no provider or authority is exercised. */
import type { Sandbox } from "@vercel/sandbox";
import { describe, expect, it, vi } from "vitest";
import { createHostedOperatorAuthProposal } from "./hosted-operator-auth-proposal";
import { hostedOperatorSandboxSourceOptions } from "./hosted-operator-sandbox-source";
import { hostedOperatorSandboxConfigurationSchema } from "./hosted-operator-source-configuration";
import type { HostedOperatorSourceConfiguration } from "./hosted-operator-source-configuration";

const digest = "a".repeat(64);
const worker = {
  executablePath: "/vercel/sandbox/protected-installer/bin/worker",
  id: "generated-app-protected-installer-v1",
  operationScope: "generated-app-release-install-v1",
  sha256: digest,
  subcommand: "protected-generated-app-install",
};
const fields = {
  accessWorker: worker,
  authProposal: {
    executablePath: "/vercel/sandbox/protected-installer/bin/proposal",
    id: "auth-proposal",
    sha256: digest,
  },
  authWorker: worker,
  projectId: "owned-project",
  resourcesWorker: worker,
  teamId: "owned-team",
  workers: { "spend-review": worker },
};
const resource = {
  database: "owned_auth",
  environment: "preview",
  hostname: "ep-owned.example.test",
  migratorRole: "owned_migrator",
  neon: { branchId: "br_owned", projectId: "project_owned" },
  port: 5432,
  runtimeRole: "owned_runtime",
  schema: "public",
  version: 1,
} as const;

describe("protected operator immutable Sandbox source", () => {
  it("accepts existing image configurations and projects only the SDK image option", () => {
    const configuration = hostedOperatorSandboxConfigurationSchema.parse({
      ...fields,
      image: "workers@sha256:owned",
    });
    expect(hostedOperatorSandboxSourceOptions(configuration)).toEqual({
      image: "workers@sha256:owned",
    });
  });

  it("accepts snapshots and projects their SDK source option", () => {
    const configuration = hostedOperatorSandboxConfigurationSchema.parse({
      ...fields,
      source: { snapshotId: "snap_owned", type: "snapshot" },
    });
    expect(hostedOperatorSandboxSourceOptions(configuration)).toEqual({
      source: { snapshotId: "snap_owned", type: "snapshot" },
    });
  });

  it.each([
    fields,
    { ...fields, image: "image", source: { snapshotId: "snap_owned", type: "snapshot" } },
    { ...fields, source: { snapshotId: "", type: "snapshot" } },
    { ...fields, source: { type: "git", url: "https://example.test/source" } },
  ])("rejects missing, mixed or unsupported source configurations", (configuration) => {
    expect(hostedOperatorSandboxConfigurationSchema.safeParse(configuration).success).toBe(false);
  });

  it("creates the Auth proposal Sandbox from the same snapshot without an image", async () => {
    const configuration = {
      catalogAppIds: ["spend-review"],
      sandbox: hostedOperatorSandboxConfigurationSchema.parse({
        ...fields,
        source: { snapshotId: "snap_owned", type: "snapshot" },
      }),
    } as HostedOperatorSourceConfiguration;
    const runCommand = vi.fn(async ({ cmd }: { cmd: string }) => ({
      exitCode: 0,
      stdout: async () =>
        cmd === "sha256sum"
          ? `${digest}  ${fields.authProposal.executablePath}\n`
          : JSON.stringify({
              proposal: "new-empty",
              resource,
              schemaPlan: { planDigest: "b".repeat(64), targetDigest: "c".repeat(64) },
              version: 1,
            }),
    }));
    const sandbox = {
      delete: vi.fn(async () => {}),
      runCommand,
      writeFiles: vi.fn(async () => {}),
    } as unknown as Pick<Sandbox, "delete" | "runCommand" | "writeFiles">;
    const createSandbox = vi.fn<
      (options: Parameters<typeof Sandbox.create>[0]) => Promise<typeof sandbox>
    >(async () => sandbox);
    const getOidc = vi.fn(async () => "synthetic-oidc-fixture");
    const propose = createHostedOperatorAuthProposal(configuration, { createSandbox, getOidc });
    const result = await propose({ assertCurrentOwner: vi.fn(async () => {}), resource });
    expect(result.planDigest).toBe("b".repeat(64));
    expect(getOidc).toHaveBeenCalledWith({ project: "owned-project", team: "owned-team" });
    expect(createSandbox.mock.calls[0]?.[0]).toMatchObject({
      env: {},
      networkPolicy: "allow-all",
      persistent: false,
      projectId: "owned-project",
      source: { snapshotId: "snap_owned", type: "snapshot" },
      teamId: "owned-team",
    });
    expect(createSandbox.mock.calls[0]?.[0]).not.toHaveProperty("image");
    expect(sandbox.delete).toHaveBeenCalledOnce();
  });
});
