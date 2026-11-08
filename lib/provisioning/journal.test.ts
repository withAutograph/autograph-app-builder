/* oxlint-disable eslint/require-await -- Provider-shaped test ports return promises while external provider effects remain unavailable. */
import { describe, expect, it } from "vitest";

import { initialBuilderProvisionJournalRecord, updateBuilderProvisionJournal } from "./journal";
import type {
  BuilderProvisionAuthority,
  BuilderProvisionJournalRow,
  BuilderProvisionJournalStore,
} from "./journal";
import { builderProvisionRequestDigest, builderProvisionRequestSchema } from "./contracts";
import type { BuilderProvisioningDependencies } from "./service";
import { executeBuilderProvisioning, readBuilderProvisioning } from "./service";

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

// Keep the in-memory journal fixture scoped to these tests.
// oxlint-disable-next-line unicorn/consistent-function-scoping
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function memoryStore(): BuilderProvisionJournalStore {
  const rows = new Map<string, BuilderProvisionJournalRow>();
  // Keep key serialization local to the in-memory store.
  // oxlint-disable-next-line unicorn/consistent-function-scoping
  const key = (value: BuilderProvisionAuthority, requestId: string) =>
    JSON.stringify([value, requestId]);
  return {
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    async compareAndSet(input) {
      const id = key(input.authority, input.requestId);
      const current = rows.get(id);
      if (!current || current.revision !== input.expectedRevision) {
        return;
      }
      const next = {
        ...current,
        record: structuredClone(input.record),
        revision: current.revision + 1,
        state: input.record.response.status,
        updatedAt: input.now,
      };
      rows.set(id, next);
      // oxlint-disable-next-line typescript/consistent-return -- Preserve compare-and-set fixture results and misses.
      return structuredClone(next);
    },
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    async read(input) {
      const row = rows.get(key(input.authority, input.requestId));
      return row ? structuredClone(row) : undefined;
    },
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    async reserve(input) {
      const id = key(input.authority, input.request.requestId);
      const digest = builderProvisionRequestDigest(input.request);
      const existing = rows.get(id);
      if (existing) {
        if (existing.requestDigest !== digest) {
          throw new Error("provision-request-id-reused");
        }
        return structuredClone(existing);
      }
      const row: BuilderProvisionJournalRow = {
        authority: input.authority,
        createdAt: input.now,
        record: initialBuilderProvisionJournalRecord(input.request, input.now),
        requestDigest: digest,
        requestId: input.request.requestId,
        revision: 1,
        state: "pending",
        updatedAt: input.now,
      };
      rows.set(id, row);
      return structuredClone(row);
    },
  };
}

describe("builder provisioning journal", () => {
  it("persists sanitized provider denial evidence across reads and reconciliation retry", async () => {
    const store = memoryStore();
    const selected = builderProvisionRequestSchema.parse({
      ...request,
      operation: "vercel",
      providers: { vercelInstallationId: "icfg_202" },
    });
    const secret = "private-credential-and-message";
    let postCount = 0;
    // SAFETY: This exercises only the selected Vercel branch; no GitHub dependency is read.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion, anti-slop/no-chained-type-assertions -- Only selected Vercel adapters are exercised; unused GitHub dependencies are intentionally absent in this branch fixture.
    const dependencies = {
      journal: store,
      // oxlint-disable-next-line eslint/require-await -- Promise-returning credential test double.
      // oxlint-disable-next-line eslint/require-await -- Promise-returning credential test double.
      readVercelCredential: async () => ({
        binding: {
          active: true,
          displayName: "Owner",
          installationId: "icfg_202",
          plan: "pro",
          scopeId: "team_1",
          scopeType: "team",
          slug: "owner",
          updatedAt: new Date(),
        },
        token: secret,
      }),
      // oxlint-disable-next-line eslint/require-await -- Promise-returning provider test double.
      // oxlint-disable-next-line eslint/require-await -- Promise-returning provider test double.
      fetch: async (_url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          postCount += 1;
          return Response.json(
            {
              error: { code: "integration_configuration_disabled", message: secret },
              token: secret,
            },
            {
              headers: { "x-vercel-id": "iad1::denied_123" },
              status: 403,
            },
          );
        }
        return postCount === 0
          ? Response.json({}, { status: 404 })
          : Response.json({ id: "unproven" });
      },
    } as unknown as BuilderProvisioningDependencies;
    const result = await executeBuilderProvisioning({
      authority,
      dependencies,
      request: selected,
    });
    expect(result.vercel).toMatchObject({
      code: "provider_permission_denied",
      providerDiagnostic: {
        code: "integration_configuration_disabled",
        requestRef: "iad1::denied_123",
        statusCode: 403,
      },
      status: "failed",
    });
    const retry = await executeBuilderProvisioning({
      authority,
      dependencies,
      request: selected,
    });
    expect(retry.vercel).toMatchObject({ code: "reconciliation_uncertain", status: "failed" });
    const projection = await readBuilderProvisioning({
      authority,
      journal: store,
      requestId: selected.requestId,
    });
    expect(
      projection?.diagnostics?.find((value) => value.provider === "vercel")?.lastProviderDiagnostic,
    ).toEqual({
      code: "integration_configuration_disabled",
      requestRef: "iad1::denied_123",
      statusCode: 403,
    });
    expect(postCount).toBe(1);
    const saved = await store.read({ authority, requestId: selected.requestId });
    expect(JSON.stringify(saved)).not.toContain(secret);
    expect(JSON.stringify(projection)).not.toContain(secret);
    expect(
      await readBuilderProvisioning({
        authority: { ...authority, ownerUserId: "other" },
        journal: store,
        requestId: selected.requestId,
      }),
    ).toBeUndefined();
  });

  it("persists sanitized provider denial evidence across reads and reconciliation retry", async () => {
    const store = memoryStore();
    const selected = builderProvisionRequestSchema.parse({
      ...request,
      operation: "vercel",
      providers: { vercelInstallationId: "icfg_202" },
    });
    const secret = "private-credential-and-message";
    let postCount = 0;
    const dependencies = {
      journal: store,
      readVercelCredential: async () => ({
        binding: {
          active: true,
          displayName: "Owner",
          installationId: "icfg_202",
          plan: "pro",
          scopeId: "team_1",
          scopeType: "team",
          slug: "owner",
          updatedAt: new Date(),
        },
        token: secret,
      }),
      fetch: async (_url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          postCount += 1;
          return Response.json(
            {
              error: { code: "integration_configuration_disabled", message: secret },
              token: secret,
            },
            {
              headers: { "x-vercel-id": "iad1::denied_123" },
              status: 403,
            },
          );
        }
        return postCount === 0
          ? Response.json({}, { status: 404 })
          : Response.json({ id: "unproven" });
      },
    };
    const result = await executeBuilderProvisioning({
      authority,
      // SAFETY: The fixture provides the real in-memory journal and only terminal token/fetch ports used by this Vercel-only request; GitHub effects are unreachable.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Deliberately bounded terminal-port fixture; runtime schemas and journal replay checks remain real.
      dependencies: dependencies as never,
      request: selected,
    });
    expect(result.vercel).toMatchObject({
      code: "provider_permission_denied",
      providerDiagnostic: {
        code: "integration_configuration_disabled",
        requestRef: "iad1::denied_123",
        statusCode: 403,
      },
      status: "failed",
    });
    const retry = await executeBuilderProvisioning({
      authority,
      // SAFETY: The fixture provides the real in-memory journal and only terminal token/fetch ports used by this Vercel-only request; GitHub effects are unreachable.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Deliberately bounded terminal-port fixture; runtime schemas and journal replay checks remain real.
      dependencies: dependencies as never,
      request: selected,
    });
    expect(retry.vercel).toMatchObject({ code: "reconciliation_uncertain", status: "failed" });
    const projection = await readBuilderProvisioning({
      authority,
      journal: store,
      requestId: selected.requestId,
    });
    expect(
      projection?.diagnostics?.find((value) => value.provider === "vercel")?.lastProviderDiagnostic,
    ).toEqual({
      code: "integration_configuration_disabled",
      requestRef: "iad1::denied_123",
      statusCode: 403,
    });
    expect(postCount).toBe(1);
    const saved = await store.read({ authority, requestId: selected.requestId });
    expect(JSON.stringify(saved)).not.toContain(secret);
    expect(JSON.stringify(projection)).not.toContain(secret);
    expect(
      await readBuilderProvisioning({
        authority: { ...authority, ownerUserId: "other" },
        journal: store,
        requestId: selected.requestId,
      }),
    ).toBeUndefined();
  });

  it("projects a due retry with a safe recovery action", async () => {
    const store = memoryStore();
    await store.reserve({ authority, now: new Date(), request });
    const nextRetryAt = new Date(Date.now() + 37_000).toISOString();
    await updateBuilderProvisionJournal({
      authority,
      requestId: request.requestId,
      store,
      update(current) {
        current.operations.github.attempted = true;
        current.operations.github.failureDetail = "provider_rate_limited";
        current.operations.github.nextRetryAt = nextRetryAt;
        current.response.github = {
          code: "provider_rate_limited",
          retryable: true,
          status: "failed",
        };
        return current;
      },
    });
    const response = await readBuilderProvisioning({
      authority,
      journal: store,
      requestId: request.requestId,
    });
    expect(response?.diagnostics).toEqual([
      {
        code: "provider_rate_limited",
        nextRetryAt,
        operation: "github",
        outcomeKnown: false,
        provider: "github",
        recoveryAction: "Builder will retry after the provider delay.",
      },
    ]);
  });
  it("persists more than five candidates and survives more than eight compare-and-set collisions", async () => {
    const underlying = memoryStore();
    await underlying.reserve({ authority, now: new Date(), request });
    let collisions = 0;
    const store: BuilderProvisionJournalStore = {
      ...underlying,
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      async compareAndSet(input) {
        collisions += 1;
        if (collisions <= 9) {
          return;
        }
        // oxlint-disable-next-line typescript/consistent-return -- Preserve compare-and-set fixture results and misses.
        return await underlying.compareAndSet(input);
      },
    };
    const updated = await updateBuilderProvisionJournal({
      authority,
      requestId: request.requestId,
      store,
      update(current) {
        current.operations.github.candidates = Array.from(
          { length: 12 },
          (_, index) => `candidate-${index}`,
        );
        return current;
      },
    });
    expect(collisions).toBe(10);
    expect(updated.record.operations.github.candidates).toHaveLength(12);
  });
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
      }),
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
          code: "provider_rejected",
          retryable: true,
          status: "failed",
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
