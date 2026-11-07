import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { prototypeArtifactChunks } from "../db/schema";
import { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import type { openHostedPostgresDatabase } from "../mcp/hosted-route";
import { operatorArtifactUnavailable } from "./hosted-operator-artifact-store";
import type { OperatorArtifactContext } from "./hosted-operator-artifact-store";
import {
  nativeTargetAuthOnlyPlanDigest,
  nativeTargetAuthOnlyPlanSchema,
} from "./native-target-auth-only-plan-schema";
import type { NativeTargetAuthOnlyPlan } from "./native-target-auth-only-plan-schema";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);

/** Retains owner-bound Auth-only plans until their separate approval lifecycle consumes them. */
export const createNativeTargetAuthOnlyPlanStore = (input: {
  database: ReturnType<typeof openHostedPostgresDatabase>;
  assertCurrentOwner: (context: OperatorArtifactContext) => Promise<void>;
}) => {
  const scope = (context: OperatorArtifactContext, appSpecDigest: string, planDigest: string) => ({
    ...hostedTenantAuthoritySchema.parse(context.authority),
    chunkIndex: 0,
    path: `_protected-operator/native-target-auth-only/${z
      .string()
      .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u)
      .parse(
        context.target.appId,
      )}/${digestSchema.parse(appSpecDigest)}/${digestSchema.parse(planDigest)}`,
    sessionId: z.string().min(1).parse(context.target.sessionId),
  });
  const predicate = (selected: ReturnType<typeof scope>) =>
    and(
      eq(prototypeArtifactChunks.issuer, selected.issuer),
      eq(prototypeArtifactChunks.audience, selected.audience),
      eq(prototypeArtifactChunks.workspaceId, selected.workspaceId),
      eq(prototypeArtifactChunks.ownerUserId, selected.ownerUserId),
      eq(prototypeArtifactChunks.sessionId, selected.sessionId),
      eq(prototypeArtifactChunks.path, selected.path),
      eq(prototypeArtifactChunks.chunkIndex, selected.chunkIndex),
    );
  const parse = (content: string, chunkDigest: string, expectedDigest: string) => {
    if (digest(content) !== chunkDigest) {
      throw operatorArtifactUnavailable();
    }
    const plan = nativeTargetAuthOnlyPlanSchema.parse(JSON.parse(content));
    if (nativeTargetAuthOnlyPlanDigest(plan) !== expectedDigest) {
      throw operatorArtifactUnavailable();
    }
    return plan;
  };
  return {
    async read(
      context: OperatorArtifactContext,
      appSpecDigest: string,
      planDigest: string,
    ): Promise<NativeTargetAuthOnlyPlan | undefined> {
      const selected = scope(context, appSpecDigest, planDigest);
      await input.assertCurrentOwner(context);
      const rows = await input.database
        .select()
        .from(prototypeArtifactChunks)
        .where(predicate(selected))
        .orderBy(
          desc(prototypeArtifactChunks.createdAt),
          desc(prototypeArtifactChunks.transferDigest),
        )
        .limit(1);
      await input.assertCurrentOwner(context);
      const row = rows.at(0);
      if (row === undefined) {
        return undefined;
      }
      const plan = parse(row.content, row.chunkDigest, planDigest);
      if (
        context.target.appId !== plan.appId ||
        context.target.sessionId !== plan.origin.publicSessionId ||
        plan.origin.appSpecDigest !== appSpecDigest ||
        !isDeepStrictEqual(
          hostedTenantAuthoritySchema.parse(context.authority),
          plan.origin.authority,
        )
      ) {
        throw operatorArtifactUnavailable();
      }
      return plan;
    },
    async record(context: OperatorArtifactContext, planInput: NativeTargetAuthOnlyPlan) {
      const plan = nativeTargetAuthOnlyPlanSchema.parse(planInput);
      if (
        context.target.appId !== plan.appId ||
        context.target.sessionId !== plan.origin.publicSessionId ||
        !isDeepStrictEqual(
          hostedTenantAuthoritySchema.parse(context.authority),
          plan.origin.authority,
        )
      ) {
        throw operatorArtifactUnavailable();
      }
      const content = JSON.stringify(plan);
      const chunkDigest = digest(content);
      const planDigest = nativeTargetAuthOnlyPlanDigest(plan);
      const selected = scope(context, plan.origin.appSpecDigest, planDigest);
      const transferDigest = digest(planDigest);
      await input.assertCurrentOwner(context);
      await input.database
        .insert(prototypeArtifactChunks)
        .values({ ...selected, transferDigest, content, chunkDigest, createdAt: new Date() })
        .onConflictDoNothing();
      const rows = await input.database
        .select()
        .from(prototypeArtifactChunks)
        .where(and(predicate(selected), eq(prototypeArtifactChunks.transferDigest, transferDigest)))
        .limit(1);
      await input.assertCurrentOwner(context);
      const row = rows.at(0);
      if (row === undefined || row.content !== content) {
        throw operatorArtifactUnavailable();
      }
      return parse(row.content, row.chunkDigest, planDigest);
    },
  };
};
