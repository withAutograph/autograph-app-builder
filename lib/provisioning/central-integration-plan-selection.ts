import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { builderProvisioningJournals } from "../db/schema";
import type { openHostedPostgresDatabase } from "../mcp/hosted-route";
import type { PublicReleaseInvocation } from "./public-release-handler";
import { centralHostCanonicalBytes } from "./central-integration-host-contract";

const pointer = z.strictObject({
  operationRef: z.uuid(),
  planDigest: z.string().regex(/^[a-f0-9]{64}$/u),
});
const recordSchema = z.strictObject({
  kind: z.literal("central-integration-plan-selection-v1"),
  scopeSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  intentId: z.uuid(),
  subscriptionRef: z.uuid(),
  selected: pointer.optional(),
});
/** Private stable planning identity, never an effect ledger or an approval. */
export const createCentralHostPlanSelection = async (input: {
  database: ReturnType<typeof openHostedPostgresDatabase>;
  invocation: PublicReleaseInvocation;
  appId: string;
  kind: "setup" | "caller";
  profileDigest: string;
  assertCurrent: () => Promise<void>;
}) => {
  const scopeSha256 = createHash("sha256")
    .update(
      centralHostCanonicalBytes({
        authority: input.invocation.authority,
        sessionId: input.invocation.sessionId,
        appId: input.appId,
        kind: input.kind,
        profileDigest: input.profileDigest,
      }),
    )
    .digest("hex");
  const requestId = `${scopeSha256.slice(0, 8)}-${scopeSha256.slice(8, 12)}-5${scopeSha256.slice(13, 16)}-a${scopeSha256.slice(17, 20)}-${scopeSha256.slice(20, 32)}`;
  const predicate = and(
    ...Object.entries(input.invocation.authority).map(([key, value]) => {
      const field = {
        issuer: builderProvisioningJournals.issuer,
        audience: builderProvisioningJournals.audience,
        workspaceId: builderProvisioningJournals.workspaceId,
        ownerUserId: builderProvisioningJournals.ownerUserId,
      }[key as keyof typeof input.invocation.authority];
      return eq(field, value);
    }),
    eq(builderProvisioningJournals.requestId, requestId),
    sql`${builderProvisioningJournals.record}->>'kind'='central-integration-plan-selection-v1'`,
  );
  const read = async () => {
    await input.assertCurrent();
    const [row] = await input.database
      .select()
      .from(builderProvisioningJournals)
      .where(predicate)
      .limit(1);
    await input.assertCurrent();
    if (row === undefined || row.requestDigest !== scopeSha256)
      throw Error("central_host_plan_selection_unavailable");
    const record = recordSchema.parse(row.record);
    if (record.scopeSha256 !== scopeSha256) throw Error("central_host_plan_selection_unavailable");
    return { row, record };
  };
  await input.assertCurrent();
  await input.database
    .insert(builderProvisioningJournals)
    .values({
      ...input.invocation.authority,
      requestId,
      requestDigest: scopeSha256,
      state: "pending",
      revision: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
      record: recordSchema.parse({
        kind: "central-integration-plan-selection-v1",
        scopeSha256,
        intentId: randomUUID(),
        subscriptionRef: randomUUID(),
      }),
    })
    .onConflictDoNothing();
  const { record } = await read();
  return {
    ...record,
    select: async (selected: z.infer<typeof pointer>) => {
      const current = await read();
      const parsed = pointer.parse(selected);
      if (current.record.selected !== undefined) {
        if (!isDeepStrictEqual(current.record.selected, parsed))
          throw Error("central_host_plan_selection_conflict");
        return;
      }
      await input.assertCurrent();
      const rows = await input.database
        .update(builderProvisioningJournals)
        .set({
          record: { ...current.record, selected: parsed },
          revision: current.row.revision + 1,
          updatedAt: new Date(),
        })
        .where(and(predicate, eq(builderProvisioningJournals.revision, current.row.revision)))
        .returning({ revision: builderProvisioningJournals.revision });
      if (rows.length !== 1) {
        const observed = await read();
        if (!isDeepStrictEqual(observed.record.selected, parsed))
          throw Error("central_host_plan_selection_conflict");
      }
      await input.assertCurrent();
    },
  };
};
