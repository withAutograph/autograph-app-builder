import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import * as schema from "../db/schema";
import {
  previewOAuthScopes,
  readPreviewOAuthContractConfig,
} from "./preview-oauth-contract";

export const cursorClientId = "autograph-cursor-desktop";
export const cursorRedirectUri = "http://localhost:8787/callback";

// Stable Better Auth schema fields, shared with the actual-handler test harness.
export function cursorClientRegistration() {
  return {
    applicationType: "native",
    clientCredentialsScopes: [],
    clientDiscoveryId: null,
    clientId: cursorClientId,
    clientSecret: null,
    disabled: false,
    dpopBoundAccessTokens: false,
    grantTypes: ["authorization_code", "refresh_token"],
    name: "Autograph for Cursor",
    redirectUris: [cursorRedirectUri],
    referenceId: null,
    requirePKCE: true,
    responseTypes: ["code"],
    scopes: [...previewOAuthScopes],
    skipConsent: false,
    tokenEndpointAuthMethod: "none",
    userId: null,
  } satisfies Partial<typeof schema.oauthClient.$inferInsert>;
}

type Database = PostgresJsDatabase<typeof schema>;
type Reader = Pick<Database, "select">;

function validateResource(resource: string) {
  readPreviewOAuthContractConfig({
    BETTER_AUTH_URL: `${new URL(resource).origin}/api/auth`,
    MCP_RESOURCE_URL: resource,
  });
}

/** Read only. Errors propagate so unavailable storage cannot expose an install link. */
export async function isCursorClientReady(
  database: Reader,
  resource: string
): Promise<boolean> {
  validateResource(resource);
  const [client] = await database
    .select()
    .from(schema.oauthClient)
    .where(eq(schema.oauthClient.clientId, cursorClientId))
    .limit(1);
  if (!client) {
    return false;
  }
  const expected = cursorClientRegistration();
  for (const key of Object.keys(expected) as (keyof typeof expected)[]) {
    const actual = client[key];
    const value = expected[key];
    if (Array.isArray(value)) {
      if (
        !Array.isArray(actual) ||
        actual.length !== value.length ||
        !value.every((entry) => actual.includes(entry))
      ) {
        return false;
      }
    } else if (actual !== value) {
      return false;
    }
  }
  const bindings = await database
    .select()
    .from(schema.oauthClientResource)
    .where(eq(schema.oauthClientResource.clientId, cursorClientId));
  if (bindings.length !== 1 || bindings[0].resourceId !== resource) {
    return false;
  }
  const [target] = await database
    .select()
    .from(schema.oauthResource)
    .where(
      and(
        eq(schema.oauthResource.identifier, resource),
        eq(schema.oauthResource.disabled, false)
      )
    )
    .limit(1);
  return Boolean(
    target &&
    previewOAuthScopes.every((scope) => target.allowedScopes?.includes(scope))
  );
}

/** Explicit deployment operation. Never invoke from request handlers or readiness checks. */
export async function setupCursorClient(database: Database, resource: string) {
  validateResource(resource);
  await database.transaction(async (tx) => {
    const [target] = await tx
      .select()
      .from(schema.oauthResource)
      .where(eq(schema.oauthResource.identifier, resource))
      .limit(1);
    if (
      !target ||
      target.disabled ||
      !previewOAuthScopes.every((scope) =>
        target.allowedScopes?.includes(scope)
      )
    ) {
      throw new Error(
        "Initialize the OAuth resource before registering Cursor."
      );
    }
    await tx
      .insert(schema.oauthClient)
      .values({
        id: randomUUID(),
        ...cursorClientRegistration(),
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .onConflictDoNothing({ target: schema.oauthClient.clientId });
    await tx
      .insert(schema.oauthClientResource)
      .values({
        clientId: cursorClientId,
        createdAt: new Date(),
        id: randomUUID(),
        resourceId: resource,
      })
      .onConflictDoNothing({
        target: [
          schema.oauthClientResource.clientId,
          schema.oauthClientResource.resourceId,
        ],
      });
    if (!(await isCursorClientReady(tx, resource))) {
      throw new Error(
        "Cursor client configuration conflicts with the dedicated public client policy."
      );
    }
  });
  return { clientId: cursorClientId, ready: true as const, resource };
}
