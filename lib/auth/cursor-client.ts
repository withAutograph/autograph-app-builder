import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { openHostedPostgresDatabase } from "../db/hosted-postgres";

import { oauthClient, oauthClientResource, oauthResource } from "../db/schema";
import { previewOAuthScopes, readPreviewOAuthContractConfig } from "./preview-oauth-contract";

export const cursorClientId = "autograph-cursor-desktop";
export const cursorRedirectUri = "http://localhost:8787/callback";

// Stable Better Auth schema fields, shared with the actual-handler test harness.
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
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
  } satisfies Partial<typeof oauthClient.$inferInsert>;
}

type Database = ReturnType<typeof openHostedPostgresDatabase>;
type Reader = Pick<Database, "select">;

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function validateResource(resource: string) {
  readPreviewOAuthContractConfig({
    BETTER_AUTH_URL: `${new URL(resource).origin}/api/auth`,
    MCP_RESOURCE_URL: resource,
  });
}

/** Read only. Errors propagate so unavailable storage cannot expose an install link. */
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export async function isCursorClientReady(database: Reader, resource: string): Promise<boolean> {
  validateResource(resource);
  const [client] = await database
    .select()
    .from(oauthClient)
    .where(eq(oauthClient.clientId, cursorClientId))
    .limit(1);
  /* oxlint-disable typescript/strict-boolean-expressions -- Preserve the existing truthiness for supported values. */
  if (!client) {
    return false;
  }
  /* oxlint-enable typescript/strict-boolean-expressions */
  const expected = cursorClientRegistration();
  for (const key of Object.keys(expected) as (keyof typeof expected)[]) {
    const actual = client[key];
    const value = expected[key];
    if (Array.isArray(value)) {
      if (
        !Array.isArray(actual) ||
        actual.length !== value.length ||
        // oxlint-disable-next-line react-doctor/js-set-map-lookups -- Compare the small registration arrays as supplied.
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
    .from(oauthClientResource)
    .where(eq(oauthClientResource.clientId, cursorClientId));
  if (bindings.length !== 1 || bindings[0].resourceId !== resource) {
    return false;
  }
  const [target] = await database
    .select()
    .from(oauthResource)
    .where(and(eq(oauthResource.identifier, resource), eq(oauthResource.disabled, false)))
    .limit(1);
  return (
    target !== undefined &&
    // oxlint-disable-next-line react-doctor/js-set-map-lookups -- Preserve the returned scope list's membership behavior.
    previewOAuthScopes.every((scope) => target.allowedScopes?.includes(scope) ?? false)
  );
}

/** Explicit deployment operation. Never invoke from request handlers or readiness checks. */
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export async function setupCursorClient(database: Database, resource: string) {
  validateResource(resource);
  await database.transaction(async (tx) => {
    const [target] = await tx
      .select()
      .from(oauthResource)
      .where(eq(oauthResource.identifier, resource))
      .limit(1);
    /* oxlint-disable typescript/strict-boolean-expressions -- Preserve the existing truthiness for supported values. */
    if (
      !target ||
      target.disabled ||
      // oxlint-disable-next-line react-doctor/js-set-map-lookups -- Preserve the returned scope list's membership behavior.
      !previewOAuthScopes.every((scope) => target.allowedScopes?.includes(scope) ?? false)
    ) {
      throw new Error("Initialize the OAuth resource before registering Cursor.");
    }
    /* oxlint-enable typescript/strict-boolean-expressions */
    await tx
      .insert(oauthClient)
      .values({
        id: randomUUID(),
        ...cursorClientRegistration(),
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .onConflictDoNothing({ target: oauthClient.clientId });
    await tx
      .insert(oauthClientResource)
      .values({
        clientId: cursorClientId,
        createdAt: new Date(),
        id: randomUUID(),
        resourceId: resource,
      })
      .onConflictDoNothing({
        target: [oauthClientResource.clientId, oauthClientResource.resourceId],
      });
    if (!(await isCursorClientReady(tx, resource))) {
      throw new Error(
        "Cursor client configuration conflicts with the dedicated public client policy.",
      );
    }
  });
  return { clientId: cursorClientId, ready: true as const, resource };
}
