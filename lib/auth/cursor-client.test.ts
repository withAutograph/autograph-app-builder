import { describe, expect, it, vi } from "vitest";
import { oauthClient, oauthClientResource, oauthResource } from "../db/schema";
import { previewOAuthScopes } from "./preview-oauth-contract";
import {
  cursorClientId,
  cursorClientRegistration,
  isCursorClientReady,
  setupCursorClient,
} from "./cursor-client";

const resource = "https://builder.example.test/mcp";

// Storage-boundary fake: real policy and Drizzle query construction run above
// this boundary; real OAuth behavior is covered by preview-oauth-real.test.ts.
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function storage() {
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- Preserve the existing open-ended value contract.
  const rows = new Map<unknown, Record<string, unknown>[]>([
    [oauthClient, []],
    [oauthClientResource, []],
    [
      oauthResource,
      [
        {
          allowedScopes: [...previewOAuthScopes],
          disabled: false,
          identifier: resource,
        },
      ],
    ],
  ]);
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Preserve the existing unknown input contract.
  const rowsFor = (table: unknown) => {
    const tableRows = rows.get(table);
    if (!tableRows) {
      throw new Error("Unknown table");
    }
    return tableRows;
  };
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Preserve the existing unknown input contract.
  const selectFrom = (table: unknown) => ({
    // oxlint-disable-next-line typescript/promise-function-async -- Preserve this test double's existing promise and synchronous behavior.
    where: () => {
      const result = Promise.resolve(rowsFor(table));
      // oxlint-disable-next-line typescript/promise-function-async -- Preserve this test double's existing promise and synchronous behavior.
      return Object.assign(result, { limit: () => result });
    },
  });
  const database = {
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Preserve the existing unknown input contract.
    insert: vi.fn((table: unknown) => ({
      // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- Preserve the existing open-ended value contract.
      values: (row: Record<string, unknown>) => ({
        // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
        onConflictDoNothing: async () => {
          const tableRows = rowsFor(table);
          if (!tableRows.length) {
            tableRows.push(row);
          }
        },
      }),
    })),
    select: vi.fn(() => ({ from: selectFrom })),
    // oxlint-disable-next-line anti-slop/no-unknown-returns, anti-slop/no-unknown-parameters -- The transaction fixture preserves the callback's arbitrary result. Preserve the existing unknown input contract.
    transaction: async (operation: (tx: unknown) => Promise<unknown>) => {
      const before = structuredClone([...rows.values()]);
      try {
        return await operation(database);
      } catch (error) {
        for (const [i, key] of [...rows.keys()].entries()) {
          rows.set(key, before[i]);
        }
        throw error;
      }
    },
  };
  return {
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion -- The database fixture implements only the OAuth client operations under test.; Preserve the existing type assertion at this boundary.
    database: database as unknown as Parameters<typeof setupCursorClient>[0],
    insert: database.insert,
    rows,
  };
}

describe("dedicated Cursor deployment registration", () => {
  it("reads readiness without mutation and registers idempotently", async () => {
    const { database, rows, insert } = storage();
    expect(await isCursorClientReady(database, resource)).toBe(false);
    expect(insert).not.toHaveBeenCalled();
    expect(await setupCursorClient(database, resource)).toEqual({
      clientId: cursorClientId,
      ready: true,
      resource,
    });
    const registered = structuredClone(rows.get(oauthClient));
    await setupCursorClient(database, resource);
    expect(rows.get(oauthClient)).toEqual(registered);
    expect(rows.get(oauthClientResource)).toHaveLength(1);
    insert.mockClear();
    expect(await isCursorClientReady(database, resource)).toBe(true);
    expect(insert).not.toHaveBeenCalled();
  });

  it.each([
    { clientSecret: "must-not-be-used" },
    { disabled: true },
    { skipConsent: true },
    { requirePKCE: false },
    { redirectUris: ["http://localhost:9999/callback"] },
    { grantTypes: ["client_credentials"] },
    { scopes: ["admin"] },
  ])("rejects conflicting policy without replacing it: %j", async (change) => {
    const { database, rows } = storage();
    rows.set(oauthClient, [{ ...cursorClientRegistration(), ...change }]);
    const before = structuredClone(rows.get(oauthClient));
    expect(await isCursorClientReady(database, resource)).toBe(false);
    await expect(setupCursorClient(database, resource)).rejects.toThrow("conflicts");
    expect(rows.get(oauthClient)).toEqual(before);
    expect(rows.get(oauthClientResource)).toEqual([]);
  });

  it("requires initialized resources and rejects a foreign resource binding", async () => {
    const { database, rows, insert } = storage();
    rows.set(oauthResource, []);
    await expect(setupCursorClient(database, resource)).rejects.toThrow("Initialize");
    expect(insert).not.toHaveBeenCalled();
    rows.set(oauthClient, [cursorClientRegistration()]);
    rows.set(oauthClientResource, [
      { clientId: cursorClientId, resourceId: "https://other.example/mcp" },
    ]);
    expect(await isCursorClientReady(database, resource)).toBe(false);
    await expect(
      isCursorClientReady(database, "https://builder.example.test/mcp?credential=unsafe"),
    ).rejects.toThrow();
  });
});
