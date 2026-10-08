import { Sandbox } from "@vercel/sandbox";
import { getVercelOidcToken } from "@vercel/oidc";
import { z } from "zod";
import { HostedOperatorError } from "./hosted-operator-contract";
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
  proposal: z.literal("new-empty"),
  resource: authProposalResourceSchema,
  schemaPlan: z.object({ planDigest: digest, targetDigest: digest }),
  version: z.literal(1),
});
type ProposalSandbox = Pick<Sandbox, "delete" | "runCommand" | "writeFiles">;
type CreateOptions = Parameters<typeof Sandbox.create>[0];

/** Credential-free proposal only; the fixed approved worker independently plans the actual database before DDL. */
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
  }) => {
    const resource = authProposalResourceSchema.parse(input.resource);
    await input.assertCurrentOwner();
    const token = await (io.getOidc ?? getVercelOidcToken)({
      project: configuration.sandbox.projectId,
      team: configuration.sandbox.teamId,
    });
    const sandbox = await (io.createSandbox ?? (async (options) => await Sandbox.create(options)))({
      env: {},
      image: configuration.sandbox.image,
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
      await sandbox.writeFiles([
        {
          content: Buffer.from(
            JSON.stringify({ catalogAppIds: configuration.catalogAppIds, resource }),
          ),
          mode: 0o600,
          path: inputPath,
        },
      ]);
      await input.assertCurrentOwner();
      const result = await sandbox.runCommand({
        args: ["auth-protected-propose", "--input-file", inputPath],
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
      if (JSON.stringify(frame.resource) !== JSON.stringify(resource)) {
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
