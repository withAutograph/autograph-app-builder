import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { builderProvisioningJournals } from "../db/schema";
import { AppAccessError } from "../app-access/errors";
import {
  repositoryProductionOperationRef,
  repositoryProductionRecordSchema,
} from "./repository-production-contract";
import type {
  RepositoryProductionScope,
  RepositoryProductionIntent,
} from "./repository-production-contract";
import {
  createRepositoryProductionSignup,
  assertNoUnresolvedRepositoryProductionSignup,
  repositoryProductionSignupOperationRef,
} from "./repository-production-signup";
import type { RepositoryProductionSignupPorts } from "./repository-production-signup";
import { createPostgresRepositoryProductionSignupStore } from "./repository-production-signup-store";

import type { RepositoryProductionSetupPorts } from "./repository-production-setup";

type Database = Parameters<typeof createPostgresRepositoryProductionSignupStore>[0];
/** Private callback composition; policy IDs resolve only through the retained owner-scoped setup. */
export const createRepositoryProductionSignupNative = (
  input: Omit<RepositoryProductionSignupPorts, "journal" | "assertNoConflictingAccess"> & {
    database: Database;
    assertAuthorized: RepositoryProductionSetupPorts["assertAuthorized"];
    hasPendingAccess: (scope: RepositoryProductionScope) => Promise<boolean>;
  },
) => {
  const journal = createPostgresRepositoryProductionSignupStore(input.database);
  const assertNoConflictingAccess = async (scope: RepositoryProductionScope) => {
    const row = await input.readSetup(scope);
    if (
      !row ||
      row.record.creatorRoleUpdate?.state === "pending" ||
      row.record.appAccessUpgrade?.state === "pending"
    ) {
      throw new AppAccessError("app_access_denied");
    }
    if (
      Object.values(row.record.effects).some((effect) => effect.state === "pending") ||
      (await input.hasPendingAccess(scope))
    ) {
      throw new AppAccessError("app_access_denied");
    }
  };
  const service = createRepositoryProductionSignup({
    ...input,
    journal,
    assertNoConflictingAccess,
  });
  return {
    async assertNoPending(
      scope: RepositoryProductionScope,
      requestedIntent?: RepositoryProductionIntent,
    ) {
      const pending = await journal.pending(scope);
      await assertNoUnresolvedRepositoryProductionSignup(pending, async (row) => {
        const setup = await input.readSetup(scope);
        if (!setup?.record.lease) {
          throw new AppAccessError("app_access_denied");
        }
        // oxlint-disable-next-line typescript/promise-function-async -- Retain the current authorization promise without changing error timing.
        const assertCurrent = () =>
          input.assertAuthorized(scope, requestedIntent ?? setup.record.intent);
        await assertCurrent();
        const result = await input.workers(scope).invokeAuthManagement(
          {
            row: {
              ...setup,
              operationRef: repositoryProductionSignupOperationRef(
                row.record.claim.policyId,
                row.record.claim.id,
                "read",
              ),
            },
            effect: "creator-access",
            assertCurrent,
            // oxlint-disable-next-line typescript/promise-function-async -- The read-only port returns the existing rejected promise directly.
            checkpoint: () => Promise.reject(new Error("read_only")),
          },
          {
            version: 1,
            realm: input.realm(scope),
            builderOrigin: input.builderOrigin,
            scope: { appId: scope.appId, organizationId: scope.organizationId },
            request: {
              action: "read-signup",
              policyId: row.record.claim.policyId,
              claimId: row.record.claim.id,
            },
          },
          true,
        );
        await assertCurrent();
        return z.object({ result: z.json() }).parse(result).result;
      });
    },
    async complete(policyId: string, claimId: string) {
      const rows = await input.database
        .select()
        .from(builderProvisioningJournals)
        .where(
          and(
            eq(builderProvisioningJournals.requestId, policyId),
            sql`${builderProvisioningJournals.record}->>'kind' = 'repository-production-setup-v1'`,
          ),
        )
        .limit(2);
      if (rows.length !== 1) {
        throw new AppAccessError("app_access_denied");
      }
      const saved = repositoryProductionRecordSchema.parse(rows[0].record);
      if (
        repositoryProductionOperationRef(saved.scope) !== policyId ||
        !(await input.readSetup(saved.scope))
      ) {
        throw new AppAccessError("app_access_denied");
      }
      return await service.complete(saved.scope, claimId);
    },
  };
};
