import { and, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { z } from "zod";

import { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import * as databaseSchema from "../db/schema";
import { hostedGitHubInstallations } from "../db/schema";

type Database = PostgresJsDatabase<typeof databaseSchema>;
export type HostedGitHubTenantAuthority = z.infer<
  typeof hostedTenantAuthoritySchema
>;

export const hostedGitHubInstallationBindingSchema = z
  .object({
    installationId: z.string().regex(/^[1-9][0-9]*$/u),
    accountId: z.string().regex(/^[1-9][0-9]*$/u),
    accountLogin: z
      .string()
      .regex(/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/u),
    accountType: z.enum(["Organization", "User"]),
    active: z.boolean(),
    updatedAt: z.date(),
  })
  .strict();

export type HostedGitHubInstallationBinding = z.infer<
  typeof hostedGitHubInstallationBindingSchema
>;

function tenantPredicate(authority: HostedGitHubTenantAuthority) {
  const parsed = hostedTenantAuthoritySchema.parse(authority);
  return and(
    eq(hostedGitHubInstallations.issuer, parsed.issuer),
    eq(hostedGitHubInstallations.audience, parsed.audience),
    eq(hostedGitHubInstallations.workspaceId, parsed.workspaceId),
    eq(hostedGitHubInstallations.ownerUserId, parsed.ownerUserId),
  );
}

export interface HostedGitHubInstallationStore {
  read(
    authority: HostedGitHubTenantAuthority,
  ): Promise<HostedGitHubInstallationBinding | undefined>;
  bind(input: {
    authority: HostedGitHubTenantAuthority;
    binding: Omit<HostedGitHubInstallationBinding, "active" | "updatedAt">;
    now: Date;
  }): Promise<HostedGitHubInstallationBinding>;
}

export function createPostgresHostedGitHubInstallationStore(
  database: Database,
): HostedGitHubInstallationStore {
  return {
    async read(authority) {
      const rows = await database
        .select({
          installationId: hostedGitHubInstallations.installationId,
          accountId: hostedGitHubInstallations.accountId,
          accountLogin: hostedGitHubInstallations.accountLogin,
          accountType: hostedGitHubInstallations.accountType,
          active: hostedGitHubInstallations.active,
          updatedAt: hostedGitHubInstallations.updatedAt,
        })
        .from(hostedGitHubInstallations)
        .where(tenantPredicate(authority))
        .limit(1);
      return rows[0] === undefined
        ? undefined
        : hostedGitHubInstallationBindingSchema.parse(rows[0]);
    },
    async bind(input) {
      const authority = hostedTenantAuthoritySchema.parse(input.authority);
      const binding = hostedGitHubInstallationBindingSchema.parse({
        ...input.binding,
        active: true,
        updatedAt: input.now,
      });
      const rows = await database
        .insert(hostedGitHubInstallations)
        .values({ ...authority, ...binding })
        .onConflictDoUpdate({
          target: [
            hostedGitHubInstallations.issuer,
            hostedGitHubInstallations.audience,
            hostedGitHubInstallations.workspaceId,
            hostedGitHubInstallations.ownerUserId,
          ],
          set: binding,
        })
        .returning({
          installationId: hostedGitHubInstallations.installationId,
          accountId: hostedGitHubInstallations.accountId,
          accountLogin: hostedGitHubInstallations.accountLogin,
          accountType: hostedGitHubInstallations.accountType,
          active: hostedGitHubInstallations.active,
          updatedAt: hostedGitHubInstallations.updatedAt,
        });
      if (rows.length !== 1)
        throw new Error("Hosted GitHub installation binding was not durable.");
      return hostedGitHubInstallationBindingSchema.parse(rows[0]);
    },
  };
}
