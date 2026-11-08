import { createHash } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { prototypeArtifactChunks } from "../db/schema";
import { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import { appDescriptionSchema } from "../repository/app-description";
import type { AppDescription } from "../repository/app-description";
import type { openHostedPostgresDatabase } from "../mcp/hosted-route";
import { operatorArtifactUnavailable } from "./hosted-operator-artifact-store";
import type { OperatorArtifactContext } from "./hosted-operator-artifact-store";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const scope = (context: OperatorArtifactContext, appSpecDigest: string) => ({
  ...hostedTenantAuthoritySchema.parse(context.authority),
  sessionId: z.string().min(1).parse(context.target.sessionId),
  path: `_protected-operator/selections/app-description/${z
    .string()
    .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u)
    .parse(context.target.appId)}/${digest.parse(appSpecDigest)}`,
  chunkIndex: 0,
});
const predicate = (value: ReturnType<typeof scope>) =>
  and(
    eq(prototypeArtifactChunks.issuer, value.issuer),
    eq(prototypeArtifactChunks.audience, value.audience),
    eq(prototypeArtifactChunks.workspaceId, value.workspaceId),
    eq(prototypeArtifactChunks.ownerUserId, value.ownerUserId),
    eq(prototypeArtifactChunks.sessionId, value.sessionId),
    eq(prototypeArtifactChunks.path, value.path),
    eq(prototypeArtifactChunks.chunkIndex, 0),
  );

/** Captured repository output, never a model-provided declaration of storage needs. */
export const createCapturedAppDescriptionStore = (input: {
  database: ReturnType<typeof openHostedPostgresDatabase>;
  assertCurrentOwner: (context: OperatorArtifactContext) => Promise<void>;
}) => {
  const parse = (
    context: OperatorArtifactContext,
    row: { content: string; chunkDigest: string },
  ) => {
    if (hash(row.content) !== row.chunkDigest) {
      throw operatorArtifactUnavailable();
    }
    const description = appDescriptionSchema.parse(JSON.parse(row.content));
    if (description.app.id !== context.target.appId) {
      throw operatorArtifactUnavailable();
    }
    return description;
  };
  return {
    async record(
      context: OperatorArtifactContext,
      appSpecDigest: string,
      callId: string,
      descriptionInput: AppDescription,
    ) {
      const description = appDescriptionSchema.parse(descriptionInput);
      const content = JSON.stringify(description);
      const chunkDigest = hash(content);
      parse(context, { content, chunkDigest });
      const selected = scope(context, appSpecDigest);
      const transferDigest = hash(z.string().min(1).parse(callId));
      await input.assertCurrentOwner(context);
      await input.database
        .insert(prototypeArtifactChunks)
        .values({
          ...selected,
          transferDigest,
          content,
          chunkDigest,
          createdAt: new Date(),
        })
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
      return parse(context, row);
    },
    async read(
      context: OperatorArtifactContext,
      appSpecDigest: string,
    ): Promise<AppDescription | undefined> {
      await input.assertCurrentOwner(context);
      const rows = await input.database
        .select()
        .from(prototypeArtifactChunks)
        .where(predicate(scope(context, appSpecDigest)))
        .orderBy(
          desc(prototypeArtifactChunks.createdAt),
          desc(prototypeArtifactChunks.transferDigest),
        )
        .limit(1);
      await input.assertCurrentOwner(context);
      const row = rows.at(0);
      return row === undefined ? undefined : parse(context, row);
    },
  };
};
