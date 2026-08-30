import { describe, expect, it } from "vitest";

import {
  initialBuilderProvisionJournalRecord,
  updateBuilderProvisionJournal,
  type BuilderProvisionAuthority,
  type BuilderProvisionJournalRow,
  type BuilderProvisionJournalStore,
} from "./journal";
import {
  builderProvisionRequestDigest,
  builderProvisionRequestSchema,
} from "./contracts";

const request = builderProvisionRequestSchema.parse({
  version: 1,
  requestId: "123e4567-e89b-42d3-a456-426614174000",
  operation: "github",
  appName: "Vendor Portal",
  repository: { name: "vendor-portal", private: true },
  providers: {
    githubInstallationId: "101",
    vercelInstallationId: "icfg_202",
  },
});
const authority = {
  issuer: "https://builder.example.test/api/auth",
  audience: "https://builder.example.test/mcp",
  workspaceId: "workspace-1",
  ownerUserId: "user-1",
} satisfies BuilderProvisionAuthority;

function memoryStore(): BuilderProvisionJournalStore {
  const rows = new Map<string, BuilderProvisionJournalRow>();
  const key = (value: BuilderProvisionAuthority, requestId: string) =>
    JSON.stringify([value, requestId]);
  return {
    async reserve(input) {
      const id = key(input.authority, input.request.requestId);
      const digest = builderProvisionRequestDigest(input.request);
      const existing = rows.get(id);
      if (existing) {
        if (existing.requestDigest !== digest)
          throw new Error("provision-request-id-reused");
        return structuredClone(existing);
      }
      const row: BuilderProvisionJournalRow = {
        authority: input.authority,
        requestId: input.request.requestId,
        requestDigest: digest,
        state: "pending",
        revision: 1,
        record: initialBuilderProvisionJournalRecord(input.request, input.now),
        createdAt: input.now,
        updatedAt: input.now,
      };
      rows.set(id, row);
      return structuredClone(row);
    },
    async read(input) {
      const row = rows.get(key(input.authority, input.requestId));
      return row ? structuredClone(row) : undefined;
    },
    async compareAndSet(input) {
      const id = key(input.authority, input.requestId);
      const current = rows.get(id);
      if (!current || current.revision !== input.expectedRevision)
        return undefined;
      const next = {
        ...current,
        state: input.record.response.status,
        revision: current.revision + 1,
        record: structuredClone(input.record),
        updatedAt: input.now,
      };
      rows.set(id, next);
      return structuredClone(next);
    },
  };
}

describe("builder provisioning journal", () => {
  it("is idempotent by tenant, request ID, and operation-independent digest", async () => {
    const store = memoryStore();
    const first = await store.reserve({ authority, request, now: new Date() });
    const retry = await store.reserve({
      authority,
      request: { ...request, operation: "vercel" },
      now: new Date(),
    });
    expect(retry.revision).toBe(first.revision);
    await expect(
      store.reserve({
        authority,
        request: {
          ...request,
          repository: { ...request.repository, name: "other" },
        },
        now: new Date(),
      }),
    ).rejects.toThrow("request-id-reused");
    const otherTenant = await store.reserve({
      authority: { ...authority, workspaceId: "workspace-2" },
      request: {
        ...request,
        repository: { ...request.repository, name: "other" },
      },
      now: new Date(),
    });
    expect(otherTenant.requestDigest).not.toBe(first.requestDigest);
  });

  it("uses compare-and-set without losing successful provider state", async () => {
    const store = memoryStore();
    await store.reserve({ authority, request, now: new Date() });
    const updated = await updateBuilderProvisionJournal({
      store,
      authority,
      requestId: request.requestId,
      update(current) {
        current.operations.github.attempted = true;
        current.response.github = {
          status: "failed",
          code: "provider_rejected",
          retryable: true,
        };
        return current;
      },
    });
    expect(updated.revision).toBe(2);
    expect(updated.record.response.status).toBe("pending");
    const stale = await store.compareAndSet({
      authority,
      requestId: request.requestId,
      expectedRevision: 1,
      record: updated.record,
      now: new Date(),
    });
    expect(stale).toBeUndefined();
  });
});
