import { isDeepStrictEqual } from "node:util";
import { Sandbox } from "@vercel/sandbox";
import { getVercelOidcToken } from "@vercel/oidc";
import { z } from "zod";
import { HostedOperatorError } from "./hosted-operator-contract";
import { hostedOperatorSandboxSourceOptions } from "./hosted-operator-sandbox-source";
import { verifyOperatorWorkerSourceCapture } from "./operator-worker-source-capture";
import { normalizeProductionAuthMigrationUrl } from "./production-auth-schema-rollout-connection";
import {
  observeAuthSchemaRolloutPhase,
  observeAuthSchemaRolloutPhaseSync,
} from "./production-auth-schema-rollout-diagnostic";
import type { AuthSchemaRolloutProfile } from "./production-auth-schema-rollout-configuration";

type ProposalSandbox = Pick<Sandbox, "delete" | "runCommand" | "writeFiles" | "readFileToBuffer">;
/** Separate Production authority: an existing resource and explicit managed operator role only. */
export const createProductionAuthSchemaProposal =
  (
    io: {
      createSandbox?: (options: Parameters<typeof Sandbox.create>[0]) => Promise<ProposalSandbox>;
      getOidc?: typeof getVercelOidcToken;
    } = {},
  ) =>
  async (input: {
    profile: AuthSchemaRolloutProfile;
    readMigrationUrl: () => Promise<string>;
    assertCurrent: () => Promise<void>;
  }) => {
    await input.assertCurrent();
    // oxlint-disable-next-line sonarjs/no-unused-vars -- The journal-only resource ID is deliberately excluded from the existing Auth database resource wire contract.
    const { resourceId: _resourceId, ...resource } = input.profile.resource;
    const { runtime } = input.profile;
    const binding = await observeAuthSchemaRolloutPhase(
      "migration_binding_read",
      input.readMigrationUrl,
    );
    const directMigrationUrl = observeAuthSchemaRolloutPhaseSync(
      "migration_binding_validation",
      () => normalizeProductionAuthMigrationUrl(binding, resource),
    );
    await input.assertCurrent();
    const token = await observeAuthSchemaRolloutPhase(
      "sandbox_oidc",
      async () =>
        await (io.getOidc ?? getVercelOidcToken)({
          project: runtime.sandbox.projectId,
          team: runtime.sandbox.teamId,
        }),
    );
    const sandbox = await observeAuthSchemaRolloutPhase(
      "sandbox_create",
      async () =>
        await (io.createSandbox ?? (async (options) => await Sandbox.create(options)))({
          env: {},
          ...hostedOperatorSandboxSourceOptions(runtime.sandbox),
          networkPolicy: "allow-all",
          persistent: false,
          ports: [],
          projectId: runtime.sandbox.projectId,
          teamId: runtime.sandbox.teamId,
          timeout: 120_000,
          token,
        }),
    );
    try {
      await input.assertCurrent();
      const worker = runtime.proposalWorker;
      await observeAuthSchemaRolloutPhase("proposal_worker_verification", async () => {
        const checksum = await sandbox.runCommand({
          cmd: "sha256sum",
          args: ["--", worker.executablePath],
          env: {},
        });
        const checksumText = await checksum.stdout();
        if (checksum.exitCode !== 0 || !checksumText.startsWith(`${worker.sha256} `)) {
          throw new HostedOperatorError("resource_mismatch");
        }
        await verifyOperatorWorkerSourceCapture({
          worker,
          readFile: async (path) => {
            const bytes = await sandbox.readFileToBuffer({ path });
            if (!bytes) {
              throw new HostedOperatorError("resource_mismatch");
            }
            return bytes;
          },
        });
      });
      // The task-owned VM receives a private credential file, never an environment value or argv.
      const inputPath = "/vercel/sandbox/auth-schema-proposal-input.json";
      const credentialPath = "/vercel/sandbox/auth-schema-proposal-migration-url";
      await input.assertCurrent();
      await observeAuthSchemaRolloutPhase("proposal_input_write", async () => {
        await sandbox.writeFiles([
          {
            path: inputPath,
            mode: 0o600,
            content: Buffer.from(
              JSON.stringify({
                resource,
                catalogAppIds: runtime.catalogAppIds,
                authOperatorRole: input.profile.authOperatorRole,
                directMigrationUrlFile: credentialPath,
              }),
            ),
          },
          { path: credentialPath, mode: 0o600, content: Buffer.from(directMigrationUrl) },
        ]);
      });
      const content = await observeAuthSchemaRolloutPhase("proposal_execution", async () => {
        const result = await sandbox.runCommand({
          cmd: worker.executablePath,
          args: ["--input-file", inputPath],
          env: {},
        });
        if (result.exitCode !== 0) {
          throw new HostedOperatorError("operator_unavailable");
        }
        return await result.stdout();
      });
      const result = observeAuthSchemaRolloutPhaseSync("proposal_validation", () => {
        // The existing Auth proposal protocol is one bounded JSON frame, not an archive or file count cap.
        if (Buffer.byteLength(content, "utf-8") > 1024 * 1024) {
          throw new HostedOperatorError("operator_unavailable");
        }
        const frame = z
          .object({
            version: z.literal(1),
            resource: z.json(),
            proposal: z.never().optional(),
            schemaPlan: z.object({ authOperatorRole: z.literal(input.profile.authOperatorRole) }),
          })
          .parse(JSON.parse(content));
        if (!isDeepStrictEqual(frame.resource, resource)) {
          throw new HostedOperatorError("resource_mismatch");
        }
        return z.json().parse(JSON.parse(content));
      });
      await input.assertCurrent();
      return result;
    } finally {
      await observeAuthSchemaRolloutPhase("proposal_cleanup", async () => {
        await sandbox.delete();
      });
    }
  };
