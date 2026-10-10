/* oxlint-disable eslint/require-await -- Synthetic adapters expose asynchronous production interfaces. */
import type postgres from "postgres";
import { describe, expect, it, vi } from "vitest";

import { createPostgresPhysicalResourceLease } from "./postgres-physical-resource-lease";
import type { PhysicalResourceFence } from "./postgres-physical-resource-lease";

const custodyKey = JSON.stringify([
  "vercel-token-key-custody-slot-v1",
  "team_fixture",
  "operator_fixture",
  "preview",
  null,
  ["VERCEL_INTEGRATION_TOKEN_KEY", "VERCEL_INTEGRATION_TOKEN_KEY_VERSION"],
]);
const fixture = () => {
  const events: string[] = [];
  const fence: PhysicalResourceFence = {
    fenceGeneration: 1,
    leaseId: "lease",
    operationRef: "operation",
  };
  const readCurrentFence = vi.fn(async () => ({ ...fence }));
  const backend = { backend_pid: 101, backend_start: "2026-10-09T11:00:00.000Z" };
  const acquired: string[] = [];
  const held = new Set<string>();
  let active = false;
  let close = vi.fn<() => void>();
  const disconnect = Promise.withResolvers<never>();
  const query = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    if (!active) {
      throw new Error("transaction closed");
    }
    const sql = strings.join("?").replaceAll(/\s+/gu, " ").trim();
    events.push(sql);
    if (sql.includes("pg_advisory_xact_lock")) {
      const key = String(values[0]);
      acquired.push(key);
      held.add(`${acquired.length}`);
      return [];
    }
    if (sql.includes("as class_id")) {
      return [{ class_id: "1", object_id: `${acquired.length}` }];
    }
    if (sql.includes("from pg_locks")) {
      return [{ held: values[0] === backend.backend_pid && held.has(String(values[2])) }];
    }
    if (sql === "set local idle_in_transaction_session_timeout = 0") {
      return [];
    }
    throw new Error(`Unexpected fixture query: ${sql}`);
  });
  const unsafe = vi.fn(async () => {
    if (!active) {
      throw new Error("transaction closed");
    }
    events.push("backend identity");
    return [{ ...backend }];
  });
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- SAFETY: Only the fixture's implemented tagged-query and unsafe ports are used by the lease.
  const transaction = Object.assign(query, { unsafe }) as unknown as postgres.TransactionSql;
  const begin = vi.fn(async <T>(run: (sql: postgres.TransactionSql) => Promise<T>) => {
    events.push("begin");
    active = true;
    try {
      const result = await Promise.race([run(transaction), disconnect.promise]);
      events.push("commit");
      return result;
    } catch (error) {
      events.push("rollback");
      throw error;
    } finally {
      active = false;
      held.clear();
    }
  });
  const end = vi.fn(async () => {
    expect(active).toBe(false);
    expect(held.size).toBe(0);
    events.push("end");
  });
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- SAFETY: This fixture implements exactly the BEGIN and cleanup ports consumed by the operation-owned client.
  const client = { begin, end } as unknown as postgres.Sql;
  const lease = createPostgresPhysicalResourceLease({
    openLockClient: (onConnectionClosed) => {
      close = vi.fn(onConnectionClosed);
      return client;
    },
  });
  return {
    acquired,
    backend,
    disconnect() {
      close();
      active = false;
      held.clear();
      disconnect.reject(new Error("fixture connection lost"));
    },
    events,
    fence,
    held,
    input: { lockKeys: [custodyKey], readCurrentFence },
    lease,
    readCurrentFence,
  };
};

describe("physical resource transaction lease", () => {
  it("locks the fixed custody slot through callback completion and invalidates retained assertions", async () => {
    const test = fixture();
    let retained: (() => Promise<void>) | undefined;
    const result = await test.lease(test.input, async (assertFence) => {
      retained = assertFence;
      expect(test.acquired).toEqual([custodyKey]);
      expect(test.held.size).toBe(1);
      await assertFence();
      return ["receipt"];
    });
    expect(result).toEqual(["receipt"]);
    expect(test.events.slice(-2)).toEqual(["commit", "end"]);
    await expect(retained?.()).rejects.toThrow("session was lost");
  });

  it("initializes an absent operation under its held slot before capturing the fence", async () => {
    const test = fixture();
    let initialized = false;
    test.readCurrentFence.mockImplementation(async () => {
      expect(initialized).toBe(true);
      return { ...test.fence };
    });
    await test.lease(
      {
        ...test.input,
        initializeUnderLock: async () => {
          expect(test.held.size).toBe(1);
          initialized = true;
        },
      },
      async (assertFence) => {
        await assertFence();
      },
    );
    expect(initialized).toBe(true);
  });

  it("sorts and deduplicates trusted physical identities", async () => {
    const test = fixture();
    await test.lease({ ...test.input, lockKeys: ["z", custodyKey, "z", "a"] }, async () => {});
    expect(test.acquired).toEqual([custodyKey, "a", "z"].toSorted());
  });

  it.each(["operationRef", "leaseId", "fenceGeneration"] as const)(
    "rejects changed %s",
    async (field) => {
      const test = fixture();
      await expect(
        test.lease(test.input, async (assertFence) => {
          if (field === "fenceGeneration") {
            test.fence.fenceGeneration += 1;
          } else {
            test.fence[field] = "replacement";
          }
          await assertFence();
        }),
      ).rejects.toThrow("fence is stale");
      expect(test.events.slice(-2)).toEqual(["rollback", "end"]);
    },
  );

  it("accepts durable checkpoints with the same current fence and propagates authority revocation", async () => {
    const test = fixture();
    let revision = 1;
    await expect(
      test.lease(test.input, async (assertFence) => {
        revision += 1;
        await assertFence();
        test.readCurrentFence.mockRejectedValueOnce(new Error("approval expired"));
        await assertFence();
      }),
    ).rejects.toThrow("approval expired");
    expect(revision).toBe(2);
    expect(test.events.slice(-2)).toEqual(["rollback", "end"]);
  });

  it.each(["backend", "lock"])("denies lost %s authority", async (change) => {
    const test = fixture();
    const effect = vi.fn();
    await expect(
      test.lease(test.input, async (assertFence) => {
        if (change === "backend") {
          test.backend.backend_pid += 1;
        } else {
          test.held.clear();
        }
        await assertFence();
        effect();
      }),
    ).rejects.toThrow();
    expect(effect).not.toHaveBeenCalled();
    expect(test.events.slice(-2)).toEqual(["rollback", "end"]);
  });

  it("denies an in-flight fence read after callback completion", async () => {
    const test = fixture();
    const entered = Promise.withResolvers<null>();
    const resume = Promise.withResolvers<null>();
    let pending: Promise<void> | undefined;
    await test.lease(test.input, async (assertFence) => {
      test.readCurrentFence.mockImplementationOnce(async () => {
        entered.resolve(null);
        await resume.promise;
        return { ...test.fence };
      });
      pending = assertFence();
      await entered.promise;
    });
    const rejected = expect(pending).rejects.toThrow("session was lost");
    resume.resolve(null);
    await rejected;
  });

  it("denies retained authority after transaction transport loss", async () => {
    const test = fixture();
    const entered = Promise.withResolvers<() => Promise<void>>();
    const resume = Promise.withResolvers<null>();
    const finished = Promise.withResolvers<null>();
    const pending = test.lease(test.input, async (assertFence) => {
      entered.resolve(assertFence);
      await resume.promise;
      await expect(assertFence()).rejects.toThrow("session was lost");
      finished.resolve(null);
    });
    const assertFence = await entered.promise;
    const rejected = expect(pending).rejects.toThrow("fixture connection lost");
    test.disconnect();
    await rejected;
    await expect(assertFence()).rejects.toThrow("session was lost");
    resume.resolve(null);
    await finished.promise;
  });
});
