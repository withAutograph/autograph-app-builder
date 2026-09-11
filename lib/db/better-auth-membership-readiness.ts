import { createHash } from "node:crypto";

import { z } from "zod";

const migrationRowSchema = z
  .object({
    issuer: z.string().min(1),
    audience: z.string().min(1),
    workspaceId: z.string().min(1),
    userId: z.string().min(1),
  })
  .strict();

const migratedRowSchema = migrationRowSchema
  .extend({ role: z.literal("owner") })
  .strict();

export const betterAuthMembershipReadBackSchema = z
  .object({
    transactionReadOnly: z.literal(true),
    activeLegacyRows: z.array(migrationRowSchema),
    migratedRows: z.array(migratedRowSchema),
    inactiveLegacyCount: z.number().int().nonnegative(),
    pendingInvitationCount: z.number().int().nonnegative(),
    nativeOrganizationCount: z.number().int().nonnegative(),
    orphanedActiveSessionCount: z.literal(0),
  })
  .strict();

function canonicalRows(rows: Array<z.infer<typeof migrationRowSchema>>) {
  return [...rows].sort((left, right) =>
    JSON.stringify(left).localeCompare(JSON.stringify(right)),
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
    throw new Error("Better Auth membership observation time is invalid.");
  }

  const legacyRows = canonicalRows(readBack.activeLegacyRows);
  const migratedRows = canonicalRows(
    readBack.migratedRows.map((row) => ({
      issuer: row.issuer,
      audience: row.audience,
      workspaceId: row.workspaceId,
      userId: row.userId,
    })),
  );
  if (JSON.stringify(legacyRows) !== JSON.stringify(migratedRows)) {
    throw new Error(
      "Better Auth organization membership does not exactly match active legacy authority.",
    );
  }

  const evidence = {
    activeLegacyDigest: sha256(JSON.stringify(legacyRows)),
    migratedMembershipDigest: sha256(JSON.stringify(migratedRows)),
  };
  const unsigned = {
    version: 1 as const,
    format: "autograph-better-auth-membership-migration-v1" as const,
    status: "migration-verified" as const,
    observedAt: input.observedAt.toISOString(),
    parity: {
      activeLegacyMemberships: legacyRows.length,
      migratedOrganizationMemberships: migratedRows.length,
      exact: true as const,
      ...evidence,
    },
    retainedLegacyAuthority: {
      inactiveMemberships: readBack.inactiveLegacyCount,
      deletionPerformed: false as const,
      authPathRetirementProven: false as const,
    },
    betterAuth: {
      pendingInvitations: readBack.pendingInvitationCount,
      nativeOrganizations: readBack.nativeOrganizationCount,
      orphanedActiveSessions: 0 as const,
    },
    disclosure: {
      userIdsIncluded: false as const,
      emailsIncluded: false as const,
      workspaceIdsIncluded: false as const,
      secretsIncluded: false as const,
    },
  };
  return {
    ...unsigned,
    receiptDigest: sha256(JSON.stringify(unsigned)),
  };
}
