import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import type * as databaseSchema from "../db/schema";
import { createPostgresWorkspaceMembership } from "../eve/postgres-workspace-membership";
import type { BuilderHandoffIntent } from "../handoff/contracts";
import {
  exactForwardedSessionAuthority,
  HostedSessionAuthorityError,
} from "../hosted/session-authority";
import type { HostedWorkspaceMembership } from "../mcp/request-handler";
import type {
  GitHubPublicationAdapter,
  GitHubPublicationReceiptStore,
} from "../repository/github-publication";
import {
  createPostgresHostedGitHubInstallationStore,
  hostedGitHubInstallationBindingSchema,
  mergeHostedGitHubInstallationBindings,
} from "../repository/postgres-github-installation-store";
import type {
  HostedGitHubInstallationBinding,
  HostedGitHubInstallationStore,
  HostedGitHubTenantAuthority,
} from "../repository/postgres-github-installation-store";
import { createPostgresGitHubPublicationStores } from "../repository/postgres-github-publication-store";
import type { GitHubPublicationProposalStore } from "../repository/postgres-github-publication-store";
import { composeGitHubPublicationRuntime } from "./github-publication-runtime";
import type { GitHubPublicationRuntime } from "./github-publication-runtime";

type Database = PostgresJsDatabase<typeof databaseSchema>;

export type HostedGitHubPublicationProviderFactory = (input: {
  authority: HostedGitHubTenantAuthority;
  installation: HostedGitHubInstallationBinding;
}) => GitHubPublicationAdapter | Promise<GitHubPublicationAdapter>;

export interface HostedGitHubPublicationRuntimeResolver {
  resolve(sessionAuth: unknown): Promise<GitHubPublicationRuntime>;
}

function exactGitHubPublicationAuthority(sessionAuth: unknown) {
  try {
    return exactForwardedSessionAuthority(sessionAuth);
  } catch (error) {
    if (error instanceof HostedSessionAuthorityError) {
      throw new TypeError(
        error.code === "mismatch"
          ? "Hosted GitHub publication requires matching current and initiating authority."
          : error.code === "subject"
            ? "Hosted GitHub publication requires one exact forwarded user subject."
            : "Hosted GitHub publication requires exact forwarded user authority.",
        { cause: error }
      );
    }
    throw error;
  }
}

interface PublicationStores {
  proposals: GitHubPublicationProposalStore;
  receipts: GitHubPublicationReceiptStore;
}

export interface HostedGitHubPublicationRuntimeResolverDependencies {
  readPreparedHandoff(
    sessionAuth: unknown
  ): Promise<
    | (BuilderHandoffIntent & { providers?: { githubInstallationId?: string } })
    | undefined
  >;
  membership: (database: Database) => HostedWorkspaceMembership;
  installations: (database: Database) => HostedGitHubInstallationStore;
  publicationStores: (
    database: Database,
    authority: HostedGitHubTenantAuthority
  ) => PublicationStores;
}

const defaultDependencies: HostedGitHubPublicationRuntimeResolverDependencies =
  {
    installations: createPostgresHostedGitHubInstallationStore,
    membership: createPostgresWorkspaceMembership,
    publicationStores: createPostgresGitHubPublicationStores,
    async readPreparedHandoff(sessionAuth) {
      const { readPreparedHandoffContext } = await import("./handoff-context");
      return readPreparedHandoffContext(sessionAuth);
    },
  };

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
  dependencies?: Partial<HostedGitHubPublicationRuntimeResolverDependencies>;
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

      const { authority, principal } =
        exactGitHubPublicationAuthority(sessionAuth);
      const prepared = await dependencies.readPreparedHandoff(sessionAuth);
      const selectedInstallationId =
        prepared?.providers?.githubInstallationId ??
        (prepared?.provisioning?.github.status === "succeeded"
          ? prepared.provisioning.github.installationId
          : undefined);
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

      const installations = dependencies.installations(pool);
      const legacy = await installations.read(authority);
      const selected =
        selectedInstallationId === undefined
          ? legacy
          : mergeHostedGitHubInstallationBindings(
              (await installations.list?.(authority)) ?? [],
              legacy
            ).find(
              (binding) => binding.installationId === selectedInstallationId
            );
      const installationResult =
        hostedGitHubInstallationBindingSchema.safeParse(selected);
      if (!installationResult.success || !installationResult.data.active) {
        throw new Error(
          "Hosted GitHub publication installation is inactive or unavailable."
        );
      }
      const installation = installationResult.data;

      const stores = dependencies.publicationStores(pool, authority);
      const adapter = await input.providerFactory({ authority, installation });
      return composeGitHubPublicationRuntime({
        adapter,
        enabled: true,
        proposals: stores.proposals,
        receipts: stores.receipts,
      });
    },
  };
}
