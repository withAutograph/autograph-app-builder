import { and, asc, eq, gt, isNull } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import type * as databaseSchema from "../db/schema";
import {
  hostedVercelInstallations,
  vercelInstallationAuthorizationStates,
} from "../db/schema";
import { parseProviderConnectionReturn } from "./provider-connection-return";
import { encryptVercelToken, decryptVercelToken } from "./vercel-installation";
import type {
  VercelAuthorizationStateStore,
  VercelInstallationBinding,
  VercelIntegrationConfig,
  VercelInstallationStore,
} from "./vercel-installation";

type Database = PostgresJsDatabase<typeof databaseSchema>;

function tenant(
  table: typeof hostedVercelInstallations,
  authorityInput: unknown
) {
  const authority = hostedTenantAuthoritySchema.parse(authorityInput);
  return and(
    eq(table.issuer, authority.issuer),
    eq(table.audience, authority.audience),
    eq(table.workspaceId, authority.workspaceId),
    eq(table.ownerUserId, authority.ownerUserId)
  );
}

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
        eq(hostedVercelInstallations.active, true)
      )
    )
    .limit(1);
  const row = rows[0];
  if (!row || row.tokenKeyVersion !== input.config.tokenKeyVersion) {
    return undefined;
  }
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

export function createPostgresVercelAuthorizationStateStore(
  database: Database
): VercelAuthorizationStateStore {
  return {
    async consume(input) {
      const rows = await database
        .update(vercelInstallationAuthorizationStates)
        .set({ consumedAt: input.now })
        .where(
          and(
            eq(
              vercelInstallationAuthorizationStates.stateDigest,
              input.stateDigest
            ),
            eq(
              vercelInstallationAuthorizationStates.authorityDigest,
              input.authorityDigest
            ),
            eq(
              vercelInstallationAuthorizationStates.issuer,
              input.authority.issuer
            ),
            eq(
              vercelInstallationAuthorizationStates.audience,
              input.authority.audience
            ),
            eq(
              vercelInstallationAuthorizationStates.workspaceId,
              input.authority.workspaceId
            ),
            eq(
              vercelInstallationAuthorizationStates.ownerUserId,
              input.authority.ownerUserId
            ),
            isNull(vercelInstallationAuthorizationStates.consumedAt),
            gt(vercelInstallationAuthorizationStates.expiresAt, input.now)
          )
        )
        .returning({
          returnTo: vercelInstallationAuthorizationStates.returnTo,
          resumeKey: vercelInstallationAuthorizationStates.resumeKey,
        });
      if (rows.length !== 1) return undefined;
      return parseProviderConnectionReturn({
        returnTo: rows[0]!.returnTo,
        ...(rows[0]?.resumeKey ? { resumeKey: rows[0].resumeKey } : {}),
      });
    },
    async create(input) {
      await database.insert(vercelInstallationAuthorizationStates).values({
        stateDigest: input.stateDigest,
        ...input.authority,
        authorityDigest: input.authorityDigest,
        returnTo: input.returnState.returnTo,
        resumeKey: input.returnState.resumeKey ?? null,
        createdAt: input.createdAt,
        expiresAt: input.expiresAt,
      });
    },
    async recover(input) {
      const rows = await database
        .select({
          returnTo: vercelInstallationAuthorizationStates.returnTo,
          resumeKey: vercelInstallationAuthorizationStates.resumeKey,
        })
        .from(vercelInstallationAuthorizationStates)
        .where(
          and(
            eq(
              vercelInstallationAuthorizationStates.stateDigest,
              input.stateDigest
            ),
            eq(
              vercelInstallationAuthorizationStates.authorityDigest,
              input.authorityDigest
            ),
            eq(
              vercelInstallationAuthorizationStates.issuer,
              input.authority.issuer
            ),
            eq(
              vercelInstallationAuthorizationStates.audience,
              input.authority.audience
            ),
            eq(
              vercelInstallationAuthorizationStates.workspaceId,
              input.authority.workspaceId
            ),
            eq(
              vercelInstallationAuthorizationStates.ownerUserId,
              input.authority.ownerUserId
            )
          )
        )
        .limit(1);
      if (!rows[0]) return undefined;
      return parseProviderConnectionReturn({
        returnTo: rows[0].returnTo,
        ...(rows[0].resumeKey ? { resumeKey: rows[0].resumeKey } : {}),
      });
    },
  };
}

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
  };
}
