import { and, asc, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { z } from "zod";

import { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import * as databaseSchema from "../db/schema";
import {
  hostedGitHubInstallationBindings,
  hostedGitHubInstallations,
} from "../db/schema";

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

export function mergeHostedGitHubInstallationBindings(
  bindings: HostedGitHubInstallationBinding[],
  legacy: HostedGitHubInstallationBinding | undefined,
) {
  return legacy === undefined ||
    bindings.some((binding) => binding.installationId === legacy.installationId)
    ? bindings
    : [...bindings, legacy];
}

function tenantPredicate(authority: HostedGitHubTenantAuthority) {
  const parsed = hostedTenantAuthoritySchema.parse(authority);
  return and(
    eq(hostedGitHubInstallations.issuer, parsed.issuer),
    eq(hostedGitHubInstallations.audience, parsed.audience),
    eq(hostedGitHubInstallations.workspaceId, parsed.workspaceId),
    eq(hostedGitHubInstallations.ownerUserId, parsed.ownerUserId),
  );
}

function bindingTenantPredicate(authority: HostedGitHubTenantAuthority) {
  const parsed = hostedTenantAuthoritySchema.parse(authority);
  return and(
    eq(hostedGitHubInstallationBindings.issuer, parsed.issuer),
    eq(hostedGitHubInstallationBindings.audience, parsed.audience),
    eq(hostedGitHubInstallationBindings.workspaceId, parsed.workspaceId),
    eq(hostedGitHubInstallationBindings.ownerUserId, parsed.ownerUserId),
  );
}

const bindingSelection = {
  installationId: hostedGitHubInstallationBindings.installationId,
  accountId: hostedGitHubInstallationBindings.accountId,
  accountLogin: hostedGitHubInstallationBindings.accountLogin,
  accountType: hostedGitHubInstallationBindings.accountType,
  active: hostedGitHubInstallationBindings.active,
  updatedAt: hostedGitHubInstallationBindings.updatedAt,
};

export interface HostedGitHubInstallationStore {
  read(
    authority: HostedGitHubTenantAuthority,
  ): Promise<HostedGitHubInstallationBinding | undefined>;
  list?(
    authority: HostedGitHubTenantAuthority,
  ): Promise<HostedGitHubInstallationBinding[]>;
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
    async list(authority) {
      const rows = await database
        .select(bindingSelection)
        .from(hostedGitHubInstallationBindings)
        .where(bindingTenantPredicate(authority))
        .orderBy(asc(hostedGitHubInstallationBindings.accountLogin));
      return rows.map((row) =>
        hostedGitHubInstallationBindingSchema.parse(row),
      );
    },
    async bind(input) {
      const authority = hostedTenantAuthoritySchema.parse(input.authority);
      const binding = hostedGitHubInstallationBindingSchema.parse({
        ...input.binding,
        active: true,
        updatedAt: input.now,
      });
      return database.transaction(async (transaction) => {
        const legacyRows = await transaction
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
        const legacy = legacyRows[0];
        if (legacy !== undefined) {
          await transaction
            .insert(hostedGitHubInstallationBindings)
            .values({ ...authority, ...legacy })
            .onConflictDoNothing();
        }

        const bindingRows = await transaction
          .insert(hostedGitHubInstallationBindings)
          .values({ ...authority, ...binding })
          .onConflictDoUpdate({
            target: [
              hostedGitHubInstallationBindings.issuer,
              hostedGitHubInstallationBindings.audience,
              hostedGitHubInstallationBindings.workspaceId,
              hostedGitHubInstallationBindings.ownerUserId,
              hostedGitHubInstallationBindings.installationId,
            ],
            set: binding,
          })
          .returning(bindingSelection);
        if (bindingRows.length !== 1)
          throw new Error(
            "Hosted GitHub installation binding was not durable.",
          );

        // Maintain the original single publication binding as an explicit
        // compatibility row. Publication continues to require its own later
        // authority check and never guesses among the selectable UI scopes.
        await transaction
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
          });
        return hostedGitHubInstallationBindingSchema.parse(bindingRows[0]);
      });
    },
  };
}
