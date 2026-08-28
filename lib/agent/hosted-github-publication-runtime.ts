import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { z } from "zod";

import { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import * as databaseSchema from "../db/schema";
import {
  hostedPrincipalSchema,
  type HostedPrincipal,
} from "../eve/hosted-auth";
import { createPostgresWorkspaceMembership } from "../eve/postgres-workspace-membership";
import type { HostedWorkspaceMembership } from "../mcp/request-handler";
import type {
  GitHubPublicationAdapter,
  GitHubPublicationReceiptStore,
} from "../repository/github-publication";
import {
  createPostgresHostedGitHubInstallationStore,
  hostedGitHubInstallationBindingSchema,
  type HostedGitHubInstallationBinding,
  type HostedGitHubInstallationStore,
  type HostedGitHubTenantAuthority,
} from "../repository/postgres-github-installation-store";
import {
  createPostgresGitHubPublicationStores,
  type GitHubPublicationProposalStore,
} from "../repository/postgres-github-publication-store";
import {
  composeGitHubPublicationRuntime,
  type GitHubPublicationRuntime,
} from "./github-publication-runtime";

type Database = PostgresJsDatabase<typeof databaseSchema>;

const forwardedAttributesSchema = z
  .object({
    "mcp:audience": z.string().url().startsWith("https://"),
    "mcp:scopes": z.array(z.string().min(1).max(100)).min(1).max(50),
    "mcp:workspace-id": z.string().min(1).max(200),
  })
  .strict();

const forwardedHostedAuthSchema = z
  .object({
    attributes: forwardedAttributesSchema,
    authenticator: z.literal("mcp-oauth-jwks"),
    issuer: z.string().url().startsWith("https://"),
    principalId: z.string().min(1).max(200),
    principalType: z.literal("user"),
    subject: z.string().min(1).max(200),
  })
  .strict();

const forwardedSessionAuthSchema = z
  .object({
    current: forwardedHostedAuthSchema,
    initiator: forwardedHostedAuthSchema,
  })
  .strict();

export type HostedGitHubPublicationProviderFactory = (input: {
  authority: HostedGitHubTenantAuthority;
  installation: HostedGitHubInstallationBinding;
}) => GitHubPublicationAdapter | Promise<GitHubPublicationAdapter>;

export interface HostedGitHubPublicationRuntimeResolver {
  resolve(sessionAuth: unknown): Promise<GitHubPublicationRuntime>;
}

type PublicationStores = {
  proposals: GitHubPublicationProposalStore;
  receipts: GitHubPublicationReceiptStore;
};

type ResolverDependencies = {
  membership: (database: Database) => HostedWorkspaceMembership;
  installations: (database: Database) => HostedGitHubInstallationStore;
  publicationStores: (
    database: Database,
    authority: HostedGitHubTenantAuthority,
  ) => PublicationStores;
};

const defaultDependencies: ResolverDependencies = {
  membership: createPostgresWorkspaceMembership,
  installations: createPostgresHostedGitHubInstallationStore,
  publicationStores: createPostgresGitHubPublicationStores,
};

function exactForwardedAuthority(sessionAuth: unknown): {
  authority: HostedGitHubTenantAuthority;
  principal: HostedPrincipal;
} {
  const parsed = forwardedSessionAuthSchema.safeParse(sessionAuth);
  if (!parsed.success) {
    throw new Error(
      "Hosted GitHub publication requires exact forwarded user authority.",
    );
  }
  const { current, initiator } = parsed.data;
  if (JSON.stringify(current) !== JSON.stringify(initiator)) {
    throw new Error(
      "Hosted GitHub publication requires matching current and initiating authority.",
    );
  }
  if (
    current.principalId !== current.subject ||
    initiator.principalId !== initiator.subject
  ) {
    throw new Error(
      "Hosted GitHub publication requires one exact forwarded user subject.",
    );
  }

  const authority = hostedTenantAuthoritySchema.parse({
    issuer: current.issuer,
    audience: current.attributes["mcp:audience"],
    workspaceId: current.attributes["mcp:workspace-id"],
    ownerUserId: current.subject,
  });
  const principal = hostedPrincipalSchema.parse({
    ...authority,
    scopes: current.attributes["mcp:scopes"],
  });
  return { authority, principal };
}

/**
 * Resolves a fresh tenant-bound runtime for one Eve session authority. Only the
 * injected database pool is cached. Membership, installation binding, stores,
 * and provider construction are re-read for every resolution.
 *
 * The resolver owns no environment parsing and cannot adopt an ambient or
 * process-wide GitHub installation identifier.
 */
export function createHostedGitHubPublicationRuntimeResolver(input: {
  enabled: boolean;
  openDatabase?: () => Database | Promise<Database>;
  providerFactory?: HostedGitHubPublicationProviderFactory;
  dependencies?: Partial<ResolverDependencies>;
}): HostedGitHubPublicationRuntimeResolver {
  let databasePromise: Promise<Database> | undefined;
  const dependencies = { ...defaultDependencies, ...input.dependencies };

  async function database(): Promise<Database> {
    if (input.openDatabase === undefined) {
      throw new Error("Hosted GitHub publication database is unconfigured.");
    }
    databasePromise ??= Promise.resolve(input.openDatabase()).catch((error) => {
      databasePromise = undefined;
      throw error;
    });
    return databasePromise;
  }

  return {
    async resolve(sessionAuth) {
      if (!input.enabled) {
        return composeGitHubPublicationRuntime({ enabled: false });
      }
      if (input.providerFactory === undefined) {
        throw new Error("Hosted GitHub publication provider is unconfigured.");
      }

      const { authority, principal } = exactForwardedAuthority(sessionAuth);
      const pool = await database();
      const membership = dependencies.membership(pool);
      if (
        !(await membership.isMember({
          principal,
          workspaceId: authority.workspaceId,
        }))
      ) {
        throw new Error("Hosted GitHub publication membership is not active.");
      }

      const installation = hostedGitHubInstallationBindingSchema.parse(
        await dependencies.installations(pool).read(authority),
      );
      if (!installation.active) {
        throw new Error("Hosted GitHub publication installation is inactive.");
      }

      const stores = dependencies.publicationStores(pool, authority);
      const adapter = await input.providerFactory({ authority, installation });
      return composeGitHubPublicationRuntime({
        enabled: true,
        adapter,
        proposals: stores.proposals,
        receipts: stores.receipts,
      });
    },
  };
}
