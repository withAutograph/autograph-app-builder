import { describe, expect, it, vi } from "vitest";
import * as schema from "../db/schema";
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
function storage() {
  const rows = new Map<unknown, Array<Record<string, unknown>>>([
    [schema.oauthClient, []],
    [schema.oauthClientResource, []],
    [
      schema.oauthResource,
      [
        {
          identifier: resource,
          disabled: false,
          allowedScopes: [...previewOAuthScopes],
        },
      ],
    ],
  ]);
  const database = {
    select: vi.fn(() => ({
      from: (table: unknown) => ({
        where: () => {
          const result = Promise.resolve(rows.get(table)!);
          return Object.assign(result, { limit: () => result });
        },
      }),
    })),
    insert: vi.fn((table: unknown) => ({
      values: (row: Record<string, unknown>) => ({
        onConflictDoNothing: async () => {
          if (!rows.get(table)!.length) rows.get(table)!.push(row);
        },
      }),
    })),
    transaction: async (operation: (tx: unknown) => Promise<unknown>) => {
      const before = structuredClone([...rows.values()]);
      try {
        return await operation(database);
      } catch (error) {
        [...rows.keys()].forEach((key, i) => rows.set(key, before[i]));
        throw error;
      }
    },
  };
  return {
    rows,
    insert: database.insert,
    database: database as unknown as Parameters<typeof setupCursorClient>[0],
  };
}

describe("dedicated Cursor deployment registration", () => {
  it("reads readiness without mutation and registers idempotently", async () => {
    const { database, rows, insert } = storage();
    expect(await isCursorClientReady(database, resource)).toBe(false);
    expect(insert).not.toHaveBeenCalled();
    expect(await setupCursorClient(database, resource)).toEqual({
      clientId: cursorClientId,
      resource,
      ready: true,
    });
    const registered = structuredClone(rows.get(schema.oauthClient));
    await setupCursorClient(database, resource);
    expect(rows.get(schema.oauthClient)).toEqual(registered);
    expect(rows.get(schema.oauthClientResource)).toHaveLength(1);
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
    rows.set(schema.oauthClient, [
      { ...cursorClientRegistration(), ...change },
    ]);
    const before = structuredClone(rows.get(schema.oauthClient));
    expect(await isCursorClientReady(database, resource)).toBe(false);
    await expect(setupCursorClient(database, resource)).rejects.toThrow(
      "conflicts",
    );
    expect(rows.get(schema.oauthClient)).toEqual(before);
    expect(rows.get(schema.oauthClientResource)).toEqual([]);
  });

  it("requires initialized resources and rejects a foreign resource binding", async () => {
    const { database, rows, insert } = storage();
    rows.set(schema.oauthResource, []);
    await expect(setupCursorClient(database, resource)).rejects.toThrow(
      "Initialize",
    );
    expect(insert).not.toHaveBeenCalled();
    rows.set(schema.oauthClient, [cursorClientRegistration()]);
    rows.set(schema.oauthClientResource, [
      { clientId: cursorClientId, resourceId: "https://other.example/mcp" },
    ]);
    expect(await isCursorClientReady(database, resource)).toBe(false);
    await expect(
      isCursorClientReady(
        database,
        "https://builder.example.test/mcp?credential=unsafe",
      ),
    ).rejects.toThrow();
  });
});
