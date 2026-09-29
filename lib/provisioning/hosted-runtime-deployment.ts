import { z } from "zod";

import { readPreparedAppContext } from "../agent/prepared-provider-context";
import { readPreviewOAuthRuntimeConfig } from "../auth/preview-oauth-runtime";
import { createPostgresWorkspaceMembership } from "../eve/postgres-workspace-membership";
import { exactForwardedSessionAuthority } from "../hosted/session-authority";
import { readActiveVercelInstallationToken } from "../integrations/postgres-vercel-installation";
import { readVercelIntegrationEnvironment } from "../integrations/vercel-installation";
import { openHostedPostgresDatabase } from "../mcp/hosted-route";
import { hostedRuntimeIdentity } from "./hosted-runtime-journal";
import type { HostedRuntimeTarget } from "./hosted-runtime-journal";
import {
  createHostedRuntimeVercelProvider,
  HostedRuntimeProviderError,
} from "./hosted-runtime-provider";
import {
  decryptHostedRuntimeFiles,
  hostedRuntimeExecutionEnvironment,
} from "./hosted-runtime-service";
import { createPostgresHostedRuntimeJournalStore } from "./postgres-hosted-runtime-journal";

/** No provider IDs or credentials are accepted from model inputs. */
export const resolveHostedRuntimeDeployment = async (input: {
  appId: string;
  branch: string;
  sessionAuth: unknown;
  sessionId: string;
  environment?: Readonly<Record<string, string | undefined>>;
}) => {
  const environment = input.environment ?? process.env;
  const { authority, principal } = exactForwardedSessionAuthority(input.sessionAuth);
  const preview = readPreviewOAuthRuntimeConfig(environment);
  const config = readVercelIntegrationEnvironment(environment);
  if (
    preview.issuer !== authority.issuer ||
    preview.resource !== authority.audience ||
    config.issuer !== authority.issuer ||
    config.resource !== authority.audience
  ) {
    throw new HostedRuntimeProviderError("authorization_required");
  }
  const database = openHostedPostgresDatabase(preview.databaseUrl);
  const membership = createPostgresWorkspaceMembership(database);
  const assertMember = async () => {
    if (!(await membership.isMember({ principal, workspaceId: authority.workspaceId }))) {
      throw new HostedRuntimeProviderError("authorization_required");
    }
  };
  await assertMember();
  const prepared = await readPreparedAppContext(input.sessionAuth);
  if (
    prepared === undefined ||
    prepared.status !== "prepared" ||
    prepared.app.id !== input.appId ||
    !prepared.resources.vercel
  ) {
    throw new HostedRuntimeProviderError("connection_required");
  }
  const project = prepared.resources.vercel;
  const target: HostedRuntimeTarget = {
    appId: input.appId,
    branch: input.branch,
    environment: "preview",
    installationId: project.installationId,
    projectId: project.projectId,
    scopeId: project.scope.id,
    scopeType: project.scope.type,
    sessionId: input.sessionId,
  };
  return {
    authority,
    config,
    async readCredential() {
      await assertMember();
      return await readActiveVercelInstallationToken({
        authority,
        config,
        database,
        installationId: target.installationId,
      });
    },
    stateDirectory: `/tmp/app-builder-runtime/${hostedRuntimeIdentity(authority, target).runtimeId}`,
    store: createPostgresHostedRuntimeJournalStore(database),
    target,
  };
};

/** Restore/launch helper for server code only. Credentials never become tool or public event fields. */
export const readHostedRuntimeExecutionBinding = async (
  input: Parameters<typeof resolveHostedRuntimeDeployment>[0],
) => {
  const runtime = await resolveHostedRuntimeDeployment(input);
  const credential = await runtime.readCredential();
  if (!credential) {
    throw new HostedRuntimeProviderError("authorization_required");
  }
  const row = await runtime.store.read(runtime);
  if (!row || row.record.status !== "prepared" || row.record.step !== "bound") {
    return null;
  }
  const files = decryptHostedRuntimeFiles({ ...runtime, record: row.record });
  if (files) {
    const provider = createHostedRuntimeVercelProvider({ credential, target: runtime.target });
    await provider.assertProject();
    const cluster = await provider.readClusterCredential();
    const original = z
      .object({ clusterUrl: z.string() })
      .parse(JSON.parse(files["state.json"] ?? "null"));
    if (original.clusterUrl !== cluster.clusterUrl) {
      throw new HostedRuntimeProviderError("resource_mismatch");
    }
  }
  return files
    ? {
        environment: hostedRuntimeExecutionEnvironment(files, input.appId),
        files,
        stateDirectory: runtime.stateDirectory,
      }
    : undefined;
};
