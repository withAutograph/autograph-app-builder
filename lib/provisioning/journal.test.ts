import { describe, expect, it } from "vitest";

import {
  builderProvisionRequestDigest,
  builderProvisionRequestSchema,
} from "./contracts";
import {
  initialBuilderProvisionJournalRecord,
  updateBuilderProvisionJournal,
} from "./journal";
import type {
  BuilderProvisionAuthority,
  BuilderProvisionJournalRow,
  BuilderProvisionJournalStore,
} from "./journal";

const request = builderProvisionRequestSchema.parse({
  appName: "Vendor Portal",
  operation: "github",
  providers: {
    githubInstallationId: "101",
    vercelInstallationId: "icfg_202",
  },
  repository: { name: "vendor-portal", private: true },
  requestId: "123e4567-e89b-42d3-a456-426614174000",
  version: 1,
});
const authority = {
  audience: "https://builder.example.test/mcp",
  issuer: "https://builder.example.test/api/auth",
  ownerUserId: "user-1",
  workspaceId: "workspace-1",
} satisfies BuilderProvisionAuthority;

function memoryStore(): BuilderProvisionJournalStore {
  const rows = new Map<string, BuilderProvisionJournalRow>();
  const key = (value: BuilderProvisionAuthority, requestId: string) =>
    JSON.stringify([value, requestId]);
  return {
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
    async read(input) {
      const row = rows.get(key(input.authority, input.requestId));
      return row ? structuredClone(row) : undefined;
    },
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
  };
}

describe("builder provisioning journal", () => {
  it("is idempotent by tenant, request ID, and operation-independent digest", async () => {
    const store = memoryStore();
    const first = await store.reserve({ authority, now: new Date(), request });
    const retry = await store.reserve({
      authority,
      now: new Date(),
      request: { ...request, operation: "vercel" },
    });
    expect(retry.revision).toBe(first.revision);
    await expect(
      store.reserve({
        authority,
        now: new Date(),
        request: {
          ...request,
          repository: { ...request.repository, name: "other" },
        },
      })
    ).rejects.toThrow("request-id-reused");
    const otherTenant = await store.reserve({
      authority: { ...authority, workspaceId: "workspace-2" },
      now: new Date(),
      request: {
        ...request,
        repository: { ...request.repository, name: "other" },
      },
    });
    expect(otherTenant.requestDigest).not.toBe(first.requestDigest);
  });

  it("uses compare-and-set without losing successful provider state", async () => {
    const store = memoryStore();
    await store.reserve({ authority, now: new Date(), request });
    const updated = await updateBuilderProvisionJournal({
      authority,
      requestId: request.requestId,
      store,
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
      expectedRevision: 1,
      now: new Date(),
      record: updated.record,
      requestId: request.requestId,
    });
    expect(stale).toBeUndefined();
  });
});
