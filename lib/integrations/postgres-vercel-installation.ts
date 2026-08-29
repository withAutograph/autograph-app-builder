import { and, asc, eq, gt, isNull } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import * as databaseSchema from "../db/schema";
import {
  hostedVercelInstallations,
  vercelInstallationAuthorizationStates,
} from "../db/schema";
import {
  encryptVercelToken,
  type VercelAuthorizationStateStore,
  type VercelInstallationBinding,
  type VercelIntegrationConfig,
  type VercelInstallationStore,
} from "./vercel-installation";

type Database = PostgresJsDatabase<typeof databaseSchema>;

function tenant(
  table: typeof hostedVercelInstallations,
  authorityInput: unknown,
) {
  const authority = hostedTenantAuthoritySchema.parse(authorityInput);
  return and(
    eq(table.issuer, authority.issuer),
    eq(table.audience, authority.audience),
    eq(table.workspaceId, authority.workspaceId),
    eq(table.ownerUserId, authority.ownerUserId),
  );
}

export function createPostgresVercelAuthorizationStateStore(
  database: Database,
): VercelAuthorizationStateStore {
  return {
    async create(input) {
      await database.insert(vercelInstallationAuthorizationStates).values({
        stateDigest: input.stateDigest,
        ...input.authority,
        authorityDigest: input.authorityDigest,
        createdAt: input.createdAt,
        expiresAt: input.expiresAt,
      });
    },
    async consume(input) {
      const rows = await database
        .update(vercelInstallationAuthorizationStates)
        .set({ consumedAt: input.now })
        .where(
          and(
            eq(
              vercelInstallationAuthorizationStates.stateDigest,
              input.stateDigest,
            ),
            eq(
              vercelInstallationAuthorizationStates.authorityDigest,
              input.authorityDigest,
            ),
            eq(
              vercelInstallationAuthorizationStates.issuer,
              input.authority.issuer,
            ),
            eq(
              vercelInstallationAuthorizationStates.audience,
              input.authority.audience,
            ),
            eq(
              vercelInstallationAuthorizationStates.workspaceId,
              input.authority.workspaceId,
            ),
            eq(
              vercelInstallationAuthorizationStates.ownerUserId,
              input.authority.ownerUserId,
            ),
            isNull(vercelInstallationAuthorizationStates.consumedAt),
            gt(vercelInstallationAuthorizationStates.expiresAt, input.now),
          ),
        )
        .returning({
          stateDigest: vercelInstallationAuthorizationStates.stateDigest,
        });
      return rows.length === 1;
    },
  };
}

export function createPostgresVercelInstallationStore(input: {
  database: Database;
  config: VercelIntegrationConfig;
}): VercelInstallationStore {
  return {
    async list(authority) {
      const rows = await input.database
        .select({
          installationId: hostedVercelInstallations.installationId,
          scopeId: hostedVercelInstallations.scopeId,
          scopeType: hostedVercelInstallations.scopeType,
          displayName: hostedVercelInstallations.displayName,
          slug: hostedVercelInstallations.slug,
          plan: hostedVercelInstallations.plan,
          active: hostedVercelInstallations.active,
          updatedAt: hostedVercelInstallations.updatedAt,
        })
        .from(hostedVercelInstallations)
        .where(tenant(hostedVercelInstallations, authority))
        .orderBy(asc(hostedVercelInstallations.displayName));
      return rows as VercelInstallationBinding[];
    },
    async bind(value) {
      const authority = hostedTenantAuthoritySchema.parse(value.authority);
      const associatedData = JSON.stringify({
        ...authority,
        installationId: value.binding.installationId,
      });
      const encrypted = encryptVercelToken({
        token: value.token,
        key: input.config.tokenKey,
        associatedData,
      });
      const row = {
        ...authority,
        ...value.binding,
        ...encrypted,
        tokenKeyVersion: input.config.tokenKeyVersion,
        active: true,
        updatedAt: value.now,
      };
      const rows = await input.database
        .insert(hostedVercelInstallations)
        .values(row)
        .onConflictDoUpdate({
          target: [
            hostedVercelInstallations.issuer,
            hostedVercelInstallations.audience,
            hostedVercelInstallations.workspaceId,
            hostedVercelInstallations.ownerUserId,
            hostedVercelInstallations.installationId,
          ],
          set: row,
        })
        .returning({
          installationId: hostedVercelInstallations.installationId,
          scopeId: hostedVercelInstallations.scopeId,
          scopeType: hostedVercelInstallations.scopeType,
          displayName: hostedVercelInstallations.displayName,
          slug: hostedVercelInstallations.slug,
          plan: hostedVercelInstallations.plan,
          active: hostedVercelInstallations.active,
          updatedAt: hostedVercelInstallations.updatedAt,
        });
      if (rows.length !== 1)
        throw new Error("Vercel installation was not durable.");
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
  };
}
