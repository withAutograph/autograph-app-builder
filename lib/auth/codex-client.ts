import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import * as schema from "../db/schema";
import { previewOAuthScopes, readPreviewOAuthContractConfig } from "./preview-oauth-contract";

export const codexClientId = "autograph-codex-desktop";
export const codexRedirectUri = "http://127.0.0.1/callback";

// Dedicated managed public client; user authorization remains normal OAuth consent.
export const codexClientRegistration = () =>
  ({
    applicationType: "native",
    clientCredentialsScopes: [],
    clientDiscoveryId: null,
    clientId: codexClientId,
    clientSecret: null,
    disabled: false,
    dpopBoundAccessTokens: false,
    grantTypes: ["authorization_code", "refresh_token"],
    name: "Autograph for Codex",
    redirectUris: [codexRedirectUri],
    referenceId: null,
    requirePKCE: true,
    responseTypes: ["code"],
    scopes: [...previewOAuthScopes],
    skipConsent: false,
    tokenEndpointAuthMethod: "none",
    userId: null,
  }) satisfies Partial<typeof schema.oauthClient.$inferInsert>;

type Database = PostgresJsDatabase<typeof schema>;
type Reader = Pick<Database, "select">;

const validateResource = (resource: string) => {
  readPreviewOAuthContractConfig({
    BETTER_AUTH_URL: `${new URL(resource).origin}/api/auth`,
    MCP_RESOURCE_URL: resource,
  });
};

/** Read only. Errors propagate so unavailable storage cannot expose an install link. */
export const isCodexClientReady = async (database: Reader, resource: string): Promise<boolean> => {
  validateResource(resource);
  const [client] = await database
    .select()
    .from(schema.oauthClient)
    .where(eq(schema.oauthClient.clientId, codexClientId))
    .limit(1);
  if (!client) {
    return false;
  }
  const expected = codexClientRegistration();
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
    .where(eq(schema.oauthClientResource.clientId, codexClientId));
  if (bindings.length !== 1 || bindings[0].resourceId !== resource) {
    return false;
  }
  const [target] = await database
    .select()
    .from(schema.oauthResource)
    .where(
      and(eq(schema.oauthResource.identifier, resource), eq(schema.oauthResource.disabled, false)),
    )
    .limit(1);
  return Boolean(
    target && previewOAuthScopes.every((scope) => target.allowedScopes?.includes(scope)),
  );
};

/** Explicit deployment operation. Never invoke from request handlers or readiness checks. */
export const setupCodexClient = async (database: Database, resource: string) => {
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
      !previewOAuthScopes.every((scope) => target.allowedScopes?.includes(scope))
    ) {
      throw new Error("Initialize the OAuth resource before registering Codex.");
    }
    const [created] = await tx
      .insert(schema.oauthClient)
      .values({
        id: randomUUID(),
        ...codexClientRegistration(),
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .onConflictDoNothing({ target: schema.oauthClient.clientId })
      .returning({ id: schema.oauthClient.id });
    if (created) {
      await tx.insert(schema.oauthClientResource).values({
        clientId: codexClientId,
        createdAt: new Date(),
        id: randomUUID(),
        resourceId: resource,
      });
    }
    if (!(await isCodexClientReady(tx, resource))) {
      throw new Error(
        "Codex client configuration conflicts with the dedicated public client policy.",
      );
    }
  });
  return { clientId: codexClientId, ready: true as const, resource };
};
