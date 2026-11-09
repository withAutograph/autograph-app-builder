/* oxlint-disable typescript/promise-function-async -- Drizzle test doubles retain thenable query objects with chainable limit methods. */
/* oxlint-disable sonarjs/no-nested-functions -- The in-memory database implements the actual fluent Drizzle transport chains. */
import { PgDialect, getTableConfig } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { builderProvisioningJournals } from "../db/schema";
import { repositoryProductionOperationRef } from "./repository-production-contract";
import type { RepositoryProductionScope } from "./repository-production-contract";
import { createPostgresRepositoryProductionSignupStore } from "./repository-production-signup-store";
import type { RepositoryProductionSignupRecord } from "./repository-production-signup";

type Raw = typeof builderProvisioningJournals.$inferSelect;
const scope: RepositoryProductionScope = {
  authority: {
    issuer: "https://builder.test/api/auth",
    audience: "https://builder.test/mcp",
    ownerUserId: "owner",
    workspaceId: "workspace",
  },
  appId: "requests",
  repositoryId: "repository",
  repositoryFullName: "example/apps",
  projectId: "project",
  organizationId: "org",
  publicOrigin: "https://apps.test",
  environment: "production",
};
const record: RepositoryProductionSignupRecord = {
  version: 1,
  kind: "repository-production-signup-v1",
  scope,
  stage: "registered",
  workerCheckpoints: [],
  claim: {
    id: "11111111-1111-4111-a111-111111111111",
    policyId: repositoryProductionOperationRef(scope),
    policyDigest: "a".repeat(64),
    scopeDigest: "b".repeat(64),
    workspaceId: "workspace",
    resourceDigest: "c".repeat(64),
    appId: "requests",
    organizationId: "org",
    actorId: "new-user",
    appRoles: [],
    returnUrl: "https://apps.test/requests",
    sessionId: "live-auth-session",
    expiresAt: "2099-01-01T00:00:00.000Z",
  },
};
const params = (where: SQL) => new PgDialect().sqlToQuery(where).params;
const matching = (row: Raw, where: SQL) => {
  const [issuer, audience, workspace, owner, policyId, target] = params(where);
  const { claim } = z.object({ claim: z.object({ policyId: z.string() }) }).parse(row.record);
  if (row.issuer !== issuer || row.audience !== audience || row.workspaceId !== workspace) {
    return false;
  }
  return (
    row.ownerUserId === owner &&
    claim.policyId === policyId &&
    (target === "pending" ? row.state === target : row.requestId === target)
  );
};
const constrain = (row: Raw) => {
  z.uuid().parse(row.requestId);
  z.enum(["pending", "settled"]).parse(row.state);
  z.string()
    .regex(/^[a-f0-9]{64}$/u)
    .parse(row.requestDigest);
  z.number().int().positive().parse(row.revision);
};

const fixture = () => {
  const rows: Raw[] = [];
  const queries = {
    select: () => ({
      from: () => ({
        where: (where: SQL) => {
          const result = rows
            .filter((row) => matching(row, where))
            .map((row) => structuredClone(row));
          return Object.assign(Promise.resolve(result), {
            limit: (limit: number) => Promise.resolve(result.slice(0, limit)),
          });
        },
      }),
    }),
    insert: () => ({
      values: (raw: Raw) => ({
        onConflictDoNothing: () => ({
          returning: () => {
            constrain(raw);
            const duplicate = rows.some((row) =>
              (["requestId", "ownerUserId", "workspaceId", "issuer", "audience"] as const).every(
                (key) => row[key] === raw[key],
              ),
            );
            if (duplicate) {
              return Promise.resolve([]);
            }
            rows.push(structuredClone(raw));
            return Promise.resolve([structuredClone(raw)]);
          },
        }),
      }),
    }),
    update: () => ({
      set: (changes: Partial<Raw>) => ({
        where: (where: SQL) => ({
          returning: () => {
            const current = rows.find(
              (row) => matching(row, where) && row.revision === params(where).at(-1),
            );
            if (!current) {
              return Promise.resolve([]);
            }
            const next = { ...current, ...changes };
            constrain(next);
            Object.assign(current, next);
            return Promise.resolve([structuredClone(next)]);
          },
        }),
      }),
    }),
  };
  const base: Parameters<typeof createPostgresRepositoryProductionSignupStore>[0] = drizzle.mock();
  return {
    store: createPostgresRepositoryProductionSignupStore(Object.assign(base, queries)),
    rows,
  };
};

describe("Production signup durable journal", () => {
  it("retains real UUID/pending-settled constraints through CAS and rejects stale writes", async () => {
    const checks = getTableConfig(builderProvisioningJournals).checks.map((check) => check.name);
    expect(checks).toContain("builder_provisioning_journal_request_id_check");
    expect(checks).toContain("builder_provisioning_journal_state_check");
    const test = fixture();
    const first = await test.store.reserve(record);
    expect(test.rows[0].state).toBe("pending");
    expect(await test.store.pending(scope)).toHaveLength(1);
    const prepared = await test.store.compareAndSet(first, {
      ...record,
      stage: "prepared",
      workerCheckpoints: [{ acknowledged: true }],
    });
    expect(prepared?.record.stage).toBe("prepared");
    expect(await test.store.compareAndSet(first, { ...record, stage: "rejected" })).toBeUndefined();
    if (!prepared) {
      throw new Error("missing prepared journal");
    }
    await expect(
      test.store.compareAndSet(prepared, { ...prepared.record, stage: "registered" }),
    ).rejects.toThrow("scope_mismatch");
    await expect(
      test.store.compareAndSet(prepared, { ...prepared.record, workerCheckpoints: [] }),
    ).rejects.toThrow("scope_mismatch");
    await expect(
      test.store.compareAndSet(prepared, {
        ...prepared.record,
        claim: { ...record.claim, actorId: "forged" },
      }),
    ).rejects.toThrow("scope_mismatch");
    const applied = await test.store.compareAndSet(prepared, {
      ...prepared.record,
      stage: "applied",
    });
    expect(applied?.record.stage).toBe("applied");
    expect(test.rows[0].state).toBe("settled");
    expect(await test.store.pending(scope)).toEqual([]);
    expect(
      await test.store.read(
        { ...scope, authority: { ...scope.authority, ownerUserId: "other" } },
        record.claim.id,
      ),
    ).toBeUndefined();
  });
});
