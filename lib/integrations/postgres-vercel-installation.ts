import { and, asc, eq, gt, isNull } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import type { z } from "zod";
import { parseProviderConnectionReturn } from "./provider-connection-return";
import { hostedVercelInstallations, vercelInstallationAuthorizationStates } from "../db/schema";
import {
  decryptVersionedVercelInstallationToken,
  encryptVercelToken,
  VercelTokenDecryptionKeyError,
  vercelInstallationTokenAssociatedData,
} from "./vercel-installation";
import type {
  VercelAuthorizationStateStore,
  VercelInstallationBinding,
  VercelIntegrationConfig,
  VercelTokenKeyringConfig,
  VercelInstallationStore,
} from "./vercel-installation";

type Database = PostgresJsDatabase;
type TenantAuthority = z.infer<typeof hostedTenantAuthoritySchema>;

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function tenant(table: typeof hostedVercelInstallations, authority: TenantAuthority) {
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
  config: VercelTokenKeyringConfig;
  authority: TenantAuthority;
  installationId: string;
}) {
  const { authority } = input;
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
  if (row === undefined) {
    return null;
  }
  let token: string;
  try {
    token = decryptVersionedVercelInstallationToken({
      authority,
      config: input.config,
      encryptedToken: row.encryptedToken,
      installationId: row.installationId,
      keyVersion: row.tokenKeyVersion,
      tokenIv: row.tokenIv,
      tokenTag: row.tokenTag,
    });
  } catch (error) {
    if (error instanceof VercelTokenDecryptionKeyError) {
      return null;
    }
    throw error;
  }
  return {
    binding: {
      active: row.active,
      displayName: row.displayName,
      installationId: row.installationId,
      plan: row.plan,
      scopeId: row.scopeId,
      // SAFETY: the database column is constrained to the Vercel scope enum at storage time.
      scopeType: row.scopeType,
      slug: row.slug,
      updatedAt: row.updatedAt,
    },
    token,
  };
}

/** Lists owner-scoped bindings without requiring OAuth client credentials or token keys. */
export const readVercelInstallationBindings = async (input: {
  database: Database;
  authority: TenantAuthority;
}): Promise<VercelInstallationBinding[]> => {
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
    .where(tenant(hostedVercelInstallations, input.authority))
    .orderBy(asc(hostedVercelInstallations.displayName));
  // SAFETY: every selected field is the corresponding VercelInstallationBinding field.
  return rows satisfies VercelInstallationBinding[];
};

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
      if (row === undefined || rows.length !== 1) {
        return null;
      }
      const returnState = { returnTo: row.returnTo } satisfies Parameters<
        typeof parseProviderConnectionReturn
      >[0];
      if (row.resumeKey !== null && row.resumeKey !== "") {
        returnState.resumeKey = row.resumeKey;
      }
      return parseProviderConnectionReturn(returnState);
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
      if (rows[0] === undefined) {
        return null;
      }
      const returnState = { returnTo: rows[0].returnTo } satisfies Parameters<
        typeof parseProviderConnectionReturn
      >[0];
      if (rows[0].resumeKey !== null && rows[0].resumeKey !== "") {
        returnState.resumeKey = rows[0].resumeKey;
      }
      return parseProviderConnectionReturn(returnState);
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
      const associatedData = vercelInstallationTokenAssociatedData(
        authority,
        value.binding.installationId,
      );
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
      if (rows.length !== 1) {
        throw new Error("Vercel installation was not durable.");
      }
      // SAFETY: returning projection contains exactly the binding fields selected above.
      return rows[0] satisfies VercelInstallationBinding;
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
      return await readVercelInstallationBindings({
        authority,
        database: input.database,
      });
    },
  };
}
