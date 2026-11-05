/* oxlint-disable eslint/require-await -- Model asynchronous database and authority ports. */
import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { builderProvisioningJournals } from "../db/schema";
import type { PrivateNativeTargetApprovalObservation } from "../eve/private-native-target-approval";
import {
  createPrivateOperatorApprovalCapture,
  readPrivateOperatorApproval,
} from "../eve/private-operator-approval-observation";
import { createNativeTargetApprovalCheckpoint } from "./native-target-onboarding-deployment";

const authority = {
  issuer: "https://builder.test/api/auth",
  audience: "https://builder.test/mcp",
  workspaceId: "workspace",
  ownerUserId: "owner",
};
const appId = "acceptance";
const planDigest = "a".repeat(64);
const observation = (
  adapterSessionId: string,
  nextNativeIndex: number,
): PrivateNativeTargetApprovalObservation => ({
  version: 1,
  native: {
    adapterSessionId,
    adapterGeneration: 1,
    nextNativeIndex,
    capture: {
      request: {
        action: "native-target",
        planRef: "retained-plan",
        planDigest,
        idempotencyKey: appId,
      },
      ownerUserId: authority.ownerUserId,
      entries: [
        {
          requestId: "prior-approved-request",
          callId: "prior-approved-call",
          approved: true,
          cancelled: false,
          completedApproved: true,
          completedCancelled: false,
        },
      ],
    },
  },
  terminals: [
    {
      requestId: "prior-approved-request",
      callId: "prior-approved-call",
      responderPrincipalId: authority.ownerUserId,
      outcome: "approved",
      observedAt: "2026-10-29T21:03:00.000Z",
    },
  ],
});

interface Row {
  issuer: string;
  audience: string;
  workspaceId: string;
  ownerUserId: string;
  requestId: string;
  requestDigest: string;
  record: unknown;
  revision: number;
  state: string;
}
const fixture = () => {
  const rows: Row[] = [];
  const dialect = new PgDialect();
  let currentAdapter = "old-adapter";
  let beforeUpdate: (() => Promise<void>) | undefined;
  let beforeInsert: (() => Promise<void>) | undefined;
  let updates = 0;
  const matching = (predicate: SQL) => {
    const { params } = dialect.sqlToQuery(predicate);
    // These are the actual authority/request key and optional CAS revision,
    // taken from Drizzle's bound parameters rather than accepting every update.
    const [issuer, audience, workspaceId, ownerUserId, requestId, revision] = params;
    return rows.find((row) =>
      [
        row.issuer === issuer,
        row.audience === audience,
        row.workspaceId === workspaceId,
        row.ownerUserId === ownerUserId,
        row.requestId === requestId,
        revision === undefined || row.revision === revision,
      ].every(Boolean),
    );
  };
  const selectWhere = (predicate: SQL) => ({
    limit: async () => {
      const row = matching(predicate);
      return row === undefined ? [] : [structuredClone(row)];
    },
  });
  const insertValues = (value: Row) => ({
    onConflictDoNothing: async () => {
      const wait = beforeInsert;
      beforeInsert = undefined;
      await wait?.();
      const duplicate = rows.some((row) =>
        [
          row.issuer === value.issuer,
          row.audience === value.audience,
          row.workspaceId === value.workspaceId,
          row.ownerUserId === value.ownerUserId,
          row.requestId === value.requestId,
        ].every(Boolean),
      );
      if (!duplicate) {
        rows.push(structuredClone(value));
      }
    },
  });
  const updateSet = (value: Partial<Row>) => ({
    where: (predicate: SQL) => ({
      returning: async () => {
        const wait = beforeUpdate;
        beforeUpdate = undefined;
        await wait?.();
        const row = matching(predicate);
        if (row === undefined) {
          return [];
        }
        Object.assign(row, structuredClone(value));
        updates += 1;
        return [{ revision: row.revision }];
      },
    }),
  });
  const databasePort = {
    select: () => ({
      from: (table: typeof builderProvisioningJournals) => {
        expect(table).toBe(builderProvisioningJournals);
        return { where: selectWhere };
      },
    }),
    insert: (table: typeof builderProvisioningJournals) => {
      expect(table).toBe(builderProvisioningJournals);
      return { values: insertValues };
    },
    update: (table: typeof builderProvisioningJournals) => {
      expect(table).toBe(builderProvisioningJournals);
      return { set: updateSet };
    },
  };
  // SAFETY: This fixture models only the three Drizzle chains used by the checkpoint,
  // including tenant/request predicates and revision CAS; no production database is opened.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- Narrow in-memory implementation of the exercised database ports.
  const database = databasePort as unknown as Parameters<
    typeof createNativeTargetApprovalCheckpoint
  >[0];
  const checkpoint = (adapterSessionId: string) =>
    createNativeTargetApprovalCheckpoint(database, authority, appId, planDigest, {
      adapterSessionId,
      adapterGeneration: 1,
      assertCurrent: async () => {
        if (currentAdapter !== adapterSessionId) {
          throw new Error("owner-revoked");
        }
      },
    });
  return {
    database,
    rows,
    checkpoint,
    current: (adapter: string) => {
      currentAdapter = adapter;
    },
    holdUpdate: (wait: () => Promise<void>) => {
      beforeUpdate = wait;
    },
    holdInsert: (wait: () => Promise<void>) => {
      beforeInsert = wait;
    },
    updates: () => updates,
  };
};

describe("native target approval checkpoint adapter epochs", () => {
  it("persists the real observer's restarted history without granting a new call or losing cancellation", async () => {
    const f = fixture();
    const prior = observation("old-adapter", 68_259);
    prior.native.capture.entries.push({
      requestId: "cancelled-request",
      callId: "cancelled-call",
      approved: false,
      cancelled: true,
      completedApproved: false,
      completedCancelled: true,
    });
    await f.checkpoint("old-adapter").save(prior);
    f.current("recovered-adapter");
    const checkpoint = f.checkpoint("recovered-adapter");
    const saved = await checkpoint.read();
    if (saved === undefined) {
      throw new Error("Checkpoint missing.");
    }
    const result = await readPrivateOperatorApproval({
      owner: {
        kind: "direct",
        authority,
        principal: { ...authority, scopes: ["autograph:session"] },
        sessionId: "saved-public-session",
        adapterSessionId: "recovered-adapter",
        adapterGeneration: 1,
      },
      observation: {
        state: saved.native,
        save: async (native) => {
          await checkpoint.save({ version: 1, native, terminals: prior.terminals });
        },
      },
      capture: (state) => {
        const capture = createPrivateOperatorApprovalCapture({
          request: prior.native.capture.request,
          ownerUserId: authority.ownerUserId,
          callId: "new-pending-call",
          state,
        });
        return { ...capture, observe: () => {} };
      },
      readHistory: async (startIndex) => {
        expect(startIndex).toBe(0);
        return { complete: true, nativeTailIndex: 14, nextNativeIndex: 14 };
      },
      assertOwner: async () => {},
    });
    expect(result).toBeNull();
    const current = await checkpoint.read();
    expect(current?.native.adapterSessionId).toBe("recovered-adapter");
    expect(current?.native.capture.entries).toEqual(prior.native.capture.entries);
    expect(
      current?.native.capture.entries.some((entry) => entry.callId === "new-pending-call"),
    ).toBe(false);
  });

  it("rolls a retained high cursor into the current adapter and advances subsequent pages", async () => {
    const f = fixture();
    const old = f.checkpoint("old-adapter");
    await old.save(observation("old-adapter", 68_259));
    f.current("recovered-adapter");
    const current = f.checkpoint("recovered-adapter");
    const priorCursor = await current.read();
    expect(priorCursor?.native.nextNativeIndex).toBe(68_259);
    const next = observation("recovered-adapter", 14);
    await current.save(next);
    expect(await current.read()).toEqual(next);
    await current.save(observation("recovered-adapter", 20));
    await current.save(observation("recovered-adapter", 25));
    expect(f.rows[0]?.revision).toBe(4);
    const afterPages = await current.read();
    expect(afterPages?.terminals).toEqual(next.terminals);
  });

  it("refuses stale cursors on the same adapter and a foreign epoch offered by its writer", async () => {
    const f = fixture();
    const checkpoint = f.checkpoint("old-adapter");
    await checkpoint.save(observation("old-adapter", 10));
    await expect(checkpoint.save(observation("old-adapter", 9))).rejects.toThrow();
    await expect(checkpoint.save(observation("foreign-adapter", 11))).rejects.toThrow();
    const unchanged = await checkpoint.read();
    expect(unchanged?.native).toMatchObject({
      adapterSessionId: "old-adapter",
      nextNativeIndex: 10,
    });
  });

  it("does not let a delayed old-owner save reverse a committed adapter rollover", async () => {
    const f = fixture();
    const old = f.checkpoint("old-adapter");
    await old.save(observation("old-adapter", 68_259));
    const { promise: held, resolve: release } = Promise.withResolvers<boolean>();
    const { promise: reached, resolve: reach } = Promise.withResolvers<boolean>();
    f.holdUpdate(async () => {
      reach(true);
      await held;
    });
    const delayed = old.save(observation("old-adapter", 68_260));
    const refused = expect(delayed).rejects.toThrow();
    await reached;
    f.current("recovered-adapter");
    const current = f.checkpoint("recovered-adapter");
    await current.read();
    await current.save(observation("recovered-adapter", 14));
    release(true);
    await refused;
    const latest = await current.read();
    expect(latest?.native).toMatchObject({
      adapterSessionId: "recovered-adapter",
      nextNativeIndex: 14,
    });
    expect(f.updates()).toBe(1);
  });

  it("rechecks current ownership before an existing checkpoint can be changed", async () => {
    const f = fixture();
    const old = f.checkpoint("old-adapter");
    await old.save(observation("old-adapter", 1));
    await old.read();
    f.current("recovered-adapter");
    await expect(old.save(observation("old-adapter", 2))).rejects.toThrow("owner-revoked");
    expect(f.updates()).toBe(0);
  });

  it("does not overwrite a newer same-adapter page from an earlier read baseline", async () => {
    const f = fixture();
    const first = f.checkpoint("old-adapter");
    await first.save(observation("old-adapter", 1));
    const stale = f.checkpoint("old-adapter");
    await stale.read();
    await first.save(observation("old-adapter", 3));
    await expect(stale.save(observation("old-adapter", 2))).rejects.toThrow();
    const current = await first.read();
    expect(current?.native.nextNativeIndex).toBe(3);
  });

  it("requires a read baseline for rollover and never replaces an insert-race winner", async () => {
    const f = fixture();
    const { promise: held, resolve: release } = Promise.withResolvers<boolean>();
    const { promise: reached, resolve: reach } = Promise.withResolvers<boolean>();
    const a = createNativeTargetApprovalCheckpoint(f.database, authority, appId, planDigest);
    const b = createNativeTargetApprovalCheckpoint(f.database, authority, appId, planDigest);
    await a.read();
    await b.read();
    f.holdInsert(async () => {
      reach(true);
      await held;
    });
    const delayed = a.save(observation("old-adapter", 68_259));
    const refused = expect(delayed).rejects.toThrow();
    await reached;
    await b.save(observation("recovered-adapter", 14));
    release(true);
    await refused;
    const winner = await b.read();
    expect(winner?.native.adapterSessionId).toBe("recovered-adapter");
    f.current("third-adapter");
    const unread = f.checkpoint("third-adapter");
    await expect(unread.save(observation("third-adapter", 1))).rejects.toThrow();
    expect(f.updates()).toBe(0);
  });

  it("keeps tenant and plan checkpoint keys separate and rejects a changed plan capture", async () => {
    const f = fixture();
    const old = f.checkpoint("old-adapter");
    await old.save(observation("old-adapter", 68_259));
    const foreignTenant = createNativeTargetApprovalCheckpoint(
      f.database,
      { ...authority, workspaceId: "other-workspace" },
      appId,
      planDigest,
    );
    const foreignPlan = createNativeTargetApprovalCheckpoint(
      f.database,
      authority,
      appId,
      "b".repeat(64),
    );
    expect(await foreignTenant.read()).toBeUndefined();
    expect(await foreignPlan.read()).toBeUndefined();
    const changed = observation("old-adapter", 68_260);
    changed.native.capture.request.planDigest = "b".repeat(64);
    await expect(old.save(changed)).rejects.toThrow();
    expect(f.rows).toHaveLength(1);
  });
});
