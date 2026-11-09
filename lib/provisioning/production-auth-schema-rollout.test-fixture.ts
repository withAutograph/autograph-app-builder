/* oxlint-disable eslint/require-await, unicorn/no-useless-undefined -- Test-owned async journal ports preserve absence and controlled asynchronous boundaries. */
import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import { z } from "zod";
import { operatorOwnerContextSchema } from "./hosted-operator-contract";
import { createAuthSchemaRollout } from "./production-auth-schema-rollout";
import type { AuthSchemaRolloutPorts } from "./production-auth-schema-rollout";
import {
  authSchemaRolloutConfigurationSchema,
  assertAuthSchemaRolloutEnrollment,
  resolveAuthSchemaRolloutProfile,
} from "./production-auth-schema-rollout-configuration";
import type { AuthSchemaRolloutRow } from "./production-auth-schema-rollout-contract";
import { authSchemaRolloutLockKey } from "./production-auth-schema-rollout-store";

export const authority = {
  issuer: "https://builder.example/api/auth",
  audience: "https://builder.example/mcp",
  workspaceId: "workspace",
  ownerUserId: "admin",
};
export const owner = operatorOwnerContextSchema.parse({
  kind: "direct",
  authority,
  principal: { ...authority, scopes: ["builder:read", "builder:write"] },
  sessionId: "session",
  adapterSessionId: "adapter",
  adapterGeneration: 1,
});
const source = {
  builder: { sha: "a".repeat(40), tree: "b".repeat(40) },
  arrusted: { sha: "c".repeat(40), tree: "d".repeat(40) },
};
export const profile = authSchemaRolloutConfigurationSchema.shape.profiles.element.parse({
  id: "arrusted",
  label: "Arrusted shared sign-in",
  administrators: [authority],
  resource: {
    version: 1,
    resourceId: "auth-original",
    environment: "production",
    hostname: "ep-auth.neon.tech",
    port: 5432,
    database: "auth",
    schema: "public",
    migratorRole: "auth_owner",
    runtimeRole: "auth_runtime",
    neon: { projectId: "neon", branchId: "branch" },
  },
  authOperatorRole: "auth_operator",
  runtime: {
    sandbox: {
      source: { type: "snapshot", snapshotId: "snapshot-original" },
      projectId: "operator",
      teamId: "team",
    },
    worker: {
      executablePath: "/opt/workers/auth",
      id: "auth-protected-schema-v1",
      operationScope: "auth-protected-schema-v1",
      subcommand: "auth-protected-schema",
      sha256: "e".repeat(64),
      sourceCapture: {
        kind: "operator-worker-catalog-v1",
        catalogPath: "/opt/workers/catalog.json",
        catalogSha256: "f".repeat(64),
        family: "auth",
        sources: source,
      },
    },
    proposalWorker: {
      executablePath: "/opt/workers/authProposal",
      id: "auth-schema-proposal-v1",
      sha256: "1".repeat(64),
      sourceCapture: {
        kind: "operator-worker-catalog-v1",
        catalogPath: "/opt/workers/catalog.json",
        catalogSha256: "f".repeat(64),
        family: "authProposal",
        sources: source,
      },
    },
    catalogAppIds: ["app-one"],
    migrationConnectionEnvironment: "ARRUSTED_AUTH_SCHEMA_OWNER_URL",
  },
});
export const configuration = authSchemaRolloutConfigurationSchema.parse({
  version: 1,
  builderWorkload: {
    audience: "https://vercel.com/team",
    issuer: "https://oidc.vercel.com/team",
    ownerId: "team",
    projectId: "builder",
    subject: "builder-production",
    environment: "production",
  },
  profiles: [profile],
});
const { resourceId: _resourceId, ...resource } = profile.resource;
export const proposal = z.json().parse({
  version: 1,
  resource,
  schemaPlan: {
    version: 1,
    resource,
    authOperatorRole: profile.authOperatorRole,
    planDigest: "2".repeat(64),
    targetDigest: "3".repeat(64),
    effects: [
      {
        owner: "operator-privileges",
        sql: "GRANT SELECT ON controlled TO auth_operator",
        sha256: "4".repeat(64),
      },
    ],
  },
});

/** Test-owned async ports retain actual approval, resource and concurrent journal behavior. */
export const rolloutFixture = () => {
  const rows = new Map<string, AuthSchemaRolloutRow>();
  const locks = new Set<string>();
  let approved = true;
  let authorized = true;
  let uncertain = false;
  let observed: "applied" | "unknown" = "unknown";
  const ports: AuthSchemaRolloutPorts = {
    store: {
      async read(scope, operationRef) {
        const row = rows.get(operationRef);
        return row &&
          isDeepStrictEqual(scope.authority, row.record.plan.scope.authority) &&
          scope.sessionId === row.record.plan.scope.sessionId
          ? structuredClone(row)
          : undefined;
      },
      async reserve(record) {
        const existing = rows.get(record.plan.operationRef);
        if (existing) {
          return structuredClone(existing);
        }
        const row = { revision: 1, record: structuredClone(record) };
        rows.set(record.plan.operationRef, row);
        return structuredClone(row);
      },
      async compareAndSet(row, record) {
        const existing = rows.get(row.record.plan.operationRef);
        if (existing?.revision !== row.revision) {
          return undefined;
        }
        const updated = { revision: row.revision + 1, record: structuredClone(record) };
        rows.set(record.plan.operationRef, updated);
        return structuredClone(updated);
      },
    },
    async assertOwner(expected) {
      if (!authorized || !isDeepStrictEqual(expected, owner)) {
        throw new Error("owner_denied");
      }
    },
    profile(scope, record) {
      return record
        ? assertAuthSchemaRolloutEnrollment(configuration, record)
        : resolveAuthSchemaRolloutProfile(configuration, scope);
    },
    propose: vi.fn(async () => proposal),
    async withLease(initial, run) {
      const key = authSchemaRolloutLockKey(initial);
      if (locks.has(key)) {
        throw new Error("lease_busy");
      }
      locks.add(key);
      try {
        const current = rows.get(initial.record.plan.operationRef);
        if (!current) {
          throw new Error("missing");
        }
        const next = await ports.store.compareAndSet(current, {
          ...current.record,
          lease: {
            leaseId: randomUUID(),
            fenceGeneration: (current.record.lease?.fenceGeneration ?? 0) + 1,
          },
        });
        if (!next) {
          throw new Error("cas");
        }
        return await run(async () => {
          if (!locks.has(key)) {
            throw new Error("lease_lost");
          }
        });
      } finally {
        locks.delete(key);
      }
    },
    approval: vi.fn<AuthSchemaRolloutPorts["approval"]>(async ({ callId }) =>
      approved ? { approvalId: "native-approval", approvedByCallId: callId } : null,
    ),
    apply: vi.fn<AuthSchemaRolloutPorts["apply"]>(
      async (row, assertCurrent, checkpoint, beforeWorkerDispatch) => {
        await assertCurrent();
        await beforeWorkerDispatch();
        if (uncertain) {
          throw new Error("lost_reply_after_dispatch");
        }
        await checkpoint({
          operationId: row.record.plan.operationRef,
          contextDigest: "5".repeat(64),
          fenceGeneration: row.record.lease?.fenceGeneration ?? 0,
          effectId: "auth:apply-schema-plan",
          resourceId: row.record.plan.resource.resourceId,
          sequence: 1,
          tenantId: null,
          receipt: { state: "applied", readbackSha256: "6".repeat(64) },
        });
      },
    ),
    inspect: vi.fn<AuthSchemaRolloutPorts["inspect"]>(async () =>
      observed === "applied"
        ? { state: "applied", readbackSha256: "7".repeat(64) }
        : { state: "unknown" },
    ),
  };
  return {
    ports,
    rows,
    service: createAuthSchemaRollout(ports),
    setApproved(value: boolean) {
      approved = value;
    },
    setAuthorized(value: boolean) {
      authorized = value;
    },
    setUncertain(value: boolean) {
      uncertain = value;
    },
    setObserved(value: typeof observed) {
      observed = value;
    },
  };
};
