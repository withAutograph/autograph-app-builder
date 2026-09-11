import { createHash } from "node:crypto";

import { z } from "zod";

const migrationRowSchema = z
  .object({
    audience: z.string().min(1),
    issuer: z.string().min(1),
    userId: z.string().min(1),
    workspaceId: z.string().min(1),
  })
  .strict();

const migratedRowSchema = migrationRowSchema
  .extend({ role: z.literal("owner") })
  .strict();

export const betterAuthMembershipReadBackSchema = z
  .object({
    activeLegacyRows: z.array(migrationRowSchema),
    inactiveLegacyCount: z.number().int().nonnegative(),
    migratedRows: z.array(migratedRowSchema),
    nativeOrganizationCount: z.number().int().nonnegative(),
    orphanedActiveSessionCount: z.literal(0),
    pendingInvitationCount: z.number().int().nonnegative(),
    transactionReadOnly: z.literal(true),
  })
  .strict();

function canonicalRows(rows: z.infer<typeof migrationRowSchema>[]) {
  return [...rows].sort((left, right) =>
    JSON.stringify(left).localeCompare(JSON.stringify(right))
  );
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function verifyBetterAuthMembershipReadBack(input: {
  readBack: unknown;
  observedAt: Date;
}) {
  const readBack = betterAuthMembershipReadBackSchema.parse(input.readBack);
  if (!Number.isFinite(input.observedAt.getTime())) {
    throw new TypeError("Better Auth membership observation time is invalid.");
  }

  const legacyRows = canonicalRows(readBack.activeLegacyRows);
  const migratedRows = canonicalRows(
    readBack.migratedRows.map((row) => ({
      audience: row.audience,
      issuer: row.issuer,
      userId: row.userId,
      workspaceId: row.workspaceId,
    }))
  );
  if (JSON.stringify(legacyRows) !== JSON.stringify(migratedRows)) {
    throw new Error(
      "Better Auth organization membership does not exactly match active legacy authority."
    );
  }

  const evidence = {
    activeLegacyDigest: sha256(JSON.stringify(legacyRows)),
    migratedMembershipDigest: sha256(JSON.stringify(migratedRows)),
  };
  const unsigned = {
    betterAuth: {
      nativeOrganizations: readBack.nativeOrganizationCount,
      orphanedActiveSessions: 0 as const,
      pendingInvitations: readBack.pendingInvitationCount,
    },
    disclosure: {
      emailsIncluded: false as const,
      secretsIncluded: false as const,
      userIdsIncluded: false as const,
      workspaceIdsIncluded: false as const,
    },
    format: "autograph-better-auth-membership-migration-v1" as const,
    observedAt: input.observedAt.toISOString(),
    parity: {
      activeLegacyMemberships: legacyRows.length,
      exact: true as const,
      migratedOrganizationMemberships: migratedRows.length,
      ...evidence,
    },
    retainedLegacyAuthority: {
      authPathRetirementProven: false as const,
      deletionPerformed: false as const,
      inactiveMemberships: readBack.inactiveLegacyCount,
    },
    status: "migration-verified" as const,
    version: 1 as const,
  };
  return {
    ...unsigned,
    receiptDigest: sha256(JSON.stringify(unsigned)),
  };
}
