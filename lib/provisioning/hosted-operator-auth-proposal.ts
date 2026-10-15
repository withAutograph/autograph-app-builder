import { Sandbox } from "@vercel/sandbox";
import { getVercelOidcToken } from "@vercel/oidc";
import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { HostedOperatorError } from "./hosted-operator-contract";
import { hostedOperatorSandboxSourceOptions } from "./hosted-operator-sandbox-source";
import type { HostedOperatorSourceConfiguration } from "./hosted-operator-source-configuration";

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const authProposalResourceSchema = z.strictObject({
  database: z.string().min(1),
  environment: z.literal("preview"),
  hostname: z.string().min(1),
  migratorRole: z.string().min(1),
  neon: z.strictObject({ branchId: z.string().min(1), projectId: z.string().min(1) }),
  port: z.literal(5432),
  runtimeRole: z.string().min(1),
  schema: z.literal("public"),
  version: z.literal(1),
});
const proposalSchema = z.object({
  proposal: z.literal("new-empty").optional(),
  resource: authProposalResourceSchema,
  schemaPlan: z.object({ planDigest: digest, targetDigest: digest }),
  version: z.literal(1),
});
type ProposalSandbox = Pick<Sandbox, "delete" | "runCommand" | "writeFiles">;
type CreateOptions = Parameters<typeof Sandbox.create>[0];

/** Private existing-target planning or credential-free genesis; execution independently replans before DDL. */
export const assertAuthProposalMigrationUrl = (
  value: string,
  resource: z.infer<typeof authProposalResourceSchema>,
) => {
  try {
    const url = new URL(value);
    if (
      [
        !["postgres:", "postgresql:"].includes(url.protocol),
        url.hostname !== resource.hostname,
        url.hostname.includes("-pooler."),
        Number(url.port || 5432) !== resource.port,
        decodeURIComponent(url.pathname.slice(1)) !== resource.database,
        decodeURIComponent(url.username) !== resource.migratorRole,
        Boolean(url.hash),
        [...url.searchParams.keys()].some((key) => !["sslmode", "channel_binding"].includes(key)),
        url.searchParams.getAll("sslmode").length !== 1,
        url.searchParams.getAll("channel_binding").length > 1,
        url.searchParams.get("sslmode") !== "verify-full",
      ].some(Boolean)
    ) {
      throw new Error("identity");
    }
  } catch {
    throw new HostedOperatorError("resource_mismatch");
  }
};
export const createHostedOperatorAuthProposal =
  (
    configuration: HostedOperatorSourceConfiguration,
    io: {
      createSandbox?: (options: CreateOptions) => Promise<ProposalSandbox>;
      getOidc?: typeof getVercelOidcToken;
    } = {},
  ) =>
  async (input: {
    assertCurrentOwner: () => Promise<void>;
    resource: z.infer<typeof authProposalResourceSchema>;
    directMigrationUrl?: string;
  }) => {
    const resource = authProposalResourceSchema.parse(input.resource);
    if (input.directMigrationUrl !== undefined) {
      assertAuthProposalMigrationUrl(input.directMigrationUrl, resource);
    }
    await input.assertCurrentOwner();
    const token = await (io.getOidc ?? getVercelOidcToken)({
      project: configuration.sandbox.projectId,
      team: configuration.sandbox.teamId,
    });
    const sandbox = await (io.createSandbox ?? (async (options) => await Sandbox.create(options)))({
      env: {},
      ...hostedOperatorSandboxSourceOptions(configuration.sandbox),
      networkPolicy: "allow-all",
      persistent: false,
      ports: [],
      projectId: configuration.sandbox.projectId,
      teamId: configuration.sandbox.teamId,
      timeout: 120_000,
      token,
    });
    try {
      await input.assertCurrentOwner();
      const worker = configuration.sandbox.authProposal;
      const checksum = await sandbox.runCommand({
        args: ["--", worker.executablePath],
        cmd: "sha256sum",
        env: {},
      });
      const checksumText = await checksum.stdout();
      if (checksum.exitCode !== 0 || !checksumText.startsWith(`${worker.sha256} `)) {
        throw new HostedOperatorError("resource_mismatch");
      }
      // oxlint-disable-next-line sonarjs/publicly-writable-directories -- Task-owned ephemeral VM input is0600 and removed with VM.
      const inputPath = "/tmp/protected-auth-proposal-input.json";
      // oxlint-disable-next-line sonarjs/publicly-writable-directories -- Private 0600 credential file in the task-owned VM.
      const credentialPath = "/tmp/protected-auth-proposal-migration-url";
      await sandbox.writeFiles([
        {
          content: Buffer.from(
            JSON.stringify({
              catalogAppIds: configuration.catalogAppIds,
              resource,
              ...(input.directMigrationUrl === undefined
                ? {}
                : { directMigrationUrlFile: credentialPath }),
            }),
          ),
          mode: 0o600,
          path: inputPath,
        },
        ...(input.directMigrationUrl === undefined
          ? []
          : [
              {
                content: Buffer.from(input.directMigrationUrl),
                mode: 0o600,
                path: credentialPath,
              },
            ]),
      ]);
      await input.assertCurrentOwner();
      const result = await sandbox.runCommand({
        args: ["--input-file", inputPath],
        cmd: worker.executablePath,
        env: {},
      });
      if (result.exitCode !== 0) {
        throw new HostedOperatorError("operator_unavailable");
      }
      const content = Buffer.from(await result.stdout(), "utf-8");
      if (content.length > 1024 * 1024) {
        throw new HostedOperatorError("operator_unavailable");
      }
      const frame = proposalSchema.parse(JSON.parse(content.toString("utf-8")));
      if (
        !isDeepStrictEqual(frame.resource, resource) ||
        (input.directMigrationUrl === undefined
          ? frame.proposal !== "new-empty"
          : frame.proposal !== undefined)
      ) {
        throw new HostedOperatorError("resource_mismatch");
      }
      await input.assertCurrentOwner();
      return {
        content,
        planDigest: frame.schemaPlan.planDigest,
        targetDigest: frame.schemaPlan.targetDigest,
      };
    } finally {
      await sandbox.delete();
    }
  };
