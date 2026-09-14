import { and, asc, eq, gt, isNull } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import { parseProviderConnectionReturn } from "./provider-connection-return";
import type * as databaseSchema from "../db/schema";
import { hostedVercelInstallations, vercelInstallationAuthorizationStates } from "../db/schema";
import { encryptVercelToken, decryptVercelToken } from "./vercel-installation";
import type {
  VercelAuthorizationStateStore,
  VercelInstallationBinding,
  VercelIntegrationConfig,
  VercelInstallationStore,
} from "./vercel-installation";

type Database = PostgresJsDatabase<typeof databaseSchema>;

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function tenant(table: typeof hostedVercelInstallations, authorityInput: unknown) {
  const authority = hostedTenantAuthoritySchema.parse(authorityInput);
  return and(
    eq(table.audience, authority.audience),
    eq(table.issuer, authority.issuer),
    eq(table.workspaceId, authority.workspaceId),
    eq(table.ownerUserId, authority.ownerUserId),
  );
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export async function readActiveVercelInstallationToken(input: {
  database: Database;
  config: VercelIntegrationConfig;
  authority: unknown;
  installationId: string;
}) {
  const authority = hostedTenantAuthoritySchema.parse(input.authority);
  const rows = await input.database
    .select()
    .from(hostedVercelInstallations)
    .where(
      and(
        tenant(hostedVercelInstallations, authority),
        eq(hostedVercelInstallations.installationId, input.installationId),
        eq(hostedVercelInstallations.active, true),
      ),
    )
    .limit(1);
  const [row] = rows;
  if (!row || row.tokenKeyVersion !== input.config.tokenKeyVersion) {return;}
  return {
    binding: {
      active: row.active,
      displayName: row.displayName,
      installationId: row.installationId,
      plan: row.plan,
      scopeId: row.scopeId,
      scopeType: row.scopeType as "team" | "user",
      slug: row.slug,
      updatedAt: row.updatedAt,
    },
    token: decryptVercelToken({
      associatedData: JSON.stringify({
        ...authority,
        installationId: row.installationId,
      }),
      encryptedToken: row.encryptedToken,
      key: input.config.tokenKey,
      tokenIv: row.tokenIv,
      tokenTag: row.tokenTag,
    }),
  };
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function createPostgresVercelAuthorizationStateStore(
  database: Database,
): VercelAuthorizationStateStore {
  return {
    async consume(input) {
      const rows = await database
        .update(vercelInstallationAuthorizationStates)
        .set({ consumedAt: input.now })
        .where(
          and(
            eq(vercelInstallationAuthorizationStates.stateDigest, input.stateDigest),
            eq(vercelInstallationAuthorizationStates.authorityDigest, input.authorityDigest),
            eq(vercelInstallationAuthorizationStates.issuer, input.authority.issuer),
            eq(vercelInstallationAuthorizationStates.audience, input.authority.audience),
            eq(vercelInstallationAuthorizationStates.workspaceId, input.authority.workspaceId),
            eq(vercelInstallationAuthorizationStates.ownerUserId, input.authority.ownerUserId),
            isNull(vercelInstallationAuthorizationStates.consumedAt),
            gt(vercelInstallationAuthorizationStates.expiresAt, input.now),
          ),
        )
        .returning({
          resumeKey: vercelInstallationAuthorizationStates.resumeKey,
          returnTo: vercelInstallationAuthorizationStates.returnTo,
        });
      const [row] = rows;
      if (!row || rows.length !== 1) {return;}
      return parseProviderConnectionReturn({
        returnTo: row.returnTo,
        ...(row.resumeKey ? { resumeKey: row.resumeKey } : {}),
      });
    },
    async create(input) {
      await database.insert(vercelInstallationAuthorizationStates).values({
        audience: input.authority.audience,
        authorityDigest: input.authorityDigest,
        createdAt: input.createdAt,
        expiresAt: input.expiresAt,
        issuer: input.authority.issuer,
        ownerUserId: input.authority.ownerUserId,
        resumeKey: input.returnState.resumeKey ?? null,
        returnTo: input.returnState.returnTo,
        stateDigest: input.stateDigest,
        workspaceId: input.authority.workspaceId,
      });
    },
    async recover(input) {
      const rows = await database
        .select({
          resumeKey: vercelInstallationAuthorizationStates.resumeKey,
          returnTo: vercelInstallationAuthorizationStates.returnTo,
        })
        .from(vercelInstallationAuthorizationStates)
        .where(
          and(
            eq(vercelInstallationAuthorizationStates.stateDigest, input.stateDigest),
            eq(vercelInstallationAuthorizationStates.authorityDigest, input.authorityDigest),
            eq(vercelInstallationAuthorizationStates.issuer, input.authority.issuer),
            eq(vercelInstallationAuthorizationStates.audience, input.authority.audience),
            eq(vercelInstallationAuthorizationStates.workspaceId, input.authority.workspaceId),
            eq(vercelInstallationAuthorizationStates.ownerUserId, input.authority.ownerUserId),
          ),
        )
        .limit(1);
      if (!rows[0]) {return;}
      return parseProviderConnectionReturn({
        returnTo: rows[0].returnTo,
        ...(rows[0].resumeKey ? { resumeKey: rows[0].resumeKey } : {}),
      });
    },
  };
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function createPostgresVercelInstallationStore(input: {
  database: Database;
  config: VercelIntegrationConfig;
}): VercelInstallationStore {
  return {
    async bind(value) {
      const authority = hostedTenantAuthoritySchema.parse(value.authority);
      const associatedData = JSON.stringify({
        ...authority,
        installationId: value.binding.installationId,
      });
      const encrypted = encryptVercelToken({
        associatedData,
        key: input.config.tokenKey,
        token: value.token,
      });
      const row = {
        ...authority,
        ...value.binding,
        ...encrypted,
        active: true,
        tokenKeyVersion: input.config.tokenKeyVersion,
        updatedAt: value.now,
      };
      const rows = await input.database
        .insert(hostedVercelInstallations)
        .values(row)
        .onConflictDoUpdate({
          set: row,
          target: [
            hostedVercelInstallations.issuer,
            hostedVercelInstallations.audience,
            hostedVercelInstallations.workspaceId,
            hostedVercelInstallations.ownerUserId,
            hostedVercelInstallations.installationId,
          ],
        })
        .returning({
          active: hostedVercelInstallations.active,
          displayName: hostedVercelInstallations.displayName,
          installationId: hostedVercelInstallations.installationId,
          plan: hostedVercelInstallations.plan,
          scopeId: hostedVercelInstallations.scopeId,
          scopeType: hostedVercelInstallations.scopeType,
          slug: hostedVercelInstallations.slug,
          updatedAt: hostedVercelInstallations.updatedAt,
        });
      if (rows.length !== 1) {throw new Error("Vercel installation was not durable.");}
      return rows[0] as VercelInstallationBinding;
    },
    async deactivate(installationId, now) {
      const rows = await input.database
        .update(hostedVercelInstallations)
        .set({ active: false, updatedAt: now })
        .where(eq(hostedVercelInstallations.installationId, installationId))
        .returning({
          installationId: hostedVercelInstallations.installationId,
        });
      return rows.length;
    },
    async list(authority) {
      const rows = await input.database
        .select({
          active: hostedVercelInstallations.active,
          displayName: hostedVercelInstallations.displayName,
          installationId: hostedVercelInstallations.installationId,
          plan: hostedVercelInstallations.plan,
          scopeId: hostedVercelInstallations.scopeId,
          scopeType: hostedVercelInstallations.scopeType,
          slug: hostedVercelInstallations.slug,
          updatedAt: hostedVercelInstallations.updatedAt,
        })
        .from(hostedVercelInstallations)
        .where(tenant(hostedVercelInstallations, authority))
        .orderBy(asc(hostedVercelInstallations.displayName));
      return rows as VercelInstallationBinding[];
    },
  };
}
