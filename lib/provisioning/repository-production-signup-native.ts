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
  repositoryProductionSignupStepOperationRef,
} from "./repository-production-signup";
import type { RepositoryProductionSignupPorts } from "./repository-production-signup";
import { createPostgresRepositoryProductionSignupStore } from "./repository-production-signup-store";
import { createRepositoryProductionSignupCancellation } from "./repository-production-signup-cancellation";

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
  const cancellation = createRepositoryProductionSignupCancellation({ ...input, journal });
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
    async cancel(value: Parameters<typeof cancellation.cancel>[0]) {
      return await cancellation.cancel(value);
    },
    async assertNoPending(
      scope: RepositoryProductionScope,
      requestedIntent?: RepositoryProductionIntent,
      cancellationTarget?: { cancelActorId: string },
      assertFence?: () => Promise<void>,
    ) {
      const rows = await journal.pending(scope);
      const targeted = rows.filter(
        (row) => row.record.claim.actorId === cancellationTarget?.cancelActorId,
      );
      if (targeted.length > 1) {
        throw new AppAccessError("app_access_denied");
      }
      const pending = rows.filter((row) => row !== targeted[0]);
      const readContext = async (row: (typeof pending)[number], step: string) => {
        if (!assertFence) {
          throw new AppAccessError("app_access_denied");
        }
        await assertFence();
        const setup = await input.readSetup(scope);
        if (!setup?.record.lease) {
          throw new AppAccessError("app_access_denied");
        }
        const assertCurrent = async () => {
          await assertFence();
          await input.assertAuthorized(scope, requestedIntent ?? setup.record.intent);
        };
        await assertCurrent();
        return {
          setup,
          assertCurrent,
          effect: {
            row: {
              ...setup,
              operationRef: repositoryProductionSignupStepOperationRef(row.record, step),
            },
            effect: "creator-access" as const,
            assertCurrent,
            // oxlint-disable-next-line typescript/promise-function-async -- The read-only port returns the existing rejected promise directly.
            checkpoint: () => Promise.reject(new Error("read_only")),
          },
        };
      };
      await assertNoUnresolvedRepositoryProductionSignup(
        pending,
        async (row) => {
          const context = await readContext(row, "read");
          const result = await input.workers(scope).invokeAuthManagement(
            context.effect,
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
          await context.assertCurrent();
          return z.object({ result: z.json() }).parse(result).result;
        },
        async (row, claim) => {
          if (!claim.recordedGrant) {
            return false;
          }
          const context = await readContext(row, "observe-grant");
          if (context.setup.record.intent.storage.kind === "postgres") {
            const observed = await input.workers(scope).inspectAppAccess(context.effect, {
              actorId: claim.actorId,
              roles: claim.appRoles,
              active: true,
              signupClaim: {
                policyId: claim.policyId,
                claimId: claim.id,
                scopeDigest: claim.scopeDigest,
              },
              signupGrantReadback: claim.recordedGrant,
            });
            await context.assertCurrent();
            if (observed.state !== "applied") {
              return false;
            }
          }
          const saved = await journal.compareAndSet(row, {
            ...row.record,
            stage: "applied",
            workerCheckpoints: [
              ...row.record.workerCheckpoints,
              {
                kind: "signup-recorded-grant",
                ...claim.recordedGrant,
                scopeDigest: claim.scopeDigest,
              },
            ],
          });
          if (!saved) {
            throw new Error("repository_production_signup_conflict");
          }
          await context.assertCurrent();
          return true;
        },
      );
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
