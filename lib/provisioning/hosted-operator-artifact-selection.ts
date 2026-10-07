import { createHash } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { z } from "zod";
// oxlint-disable-next-line sonarjs/no-wildcard-import -- The owned Drizzle schema defines this existing table.
import type * as databaseSchema from "../db/schema";
import { prototypeArtifactChunks } from "../db/schema";
import { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import {
  operatorArtifactReferenceSchema,
  operatorArtifactUnavailable,
} from "./hosted-operator-artifact-store";
import type { OperatorArtifactContext } from "./hosted-operator-artifact-store";

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const appId = z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u);
export const compiledOperatorReleaseSelectionSchema = z.strictObject({
  appId,
  appSpecDigest: digest,
  artifactRef: operatorArtifactReferenceSchema,
  manifestSha256: digest,
  releaseId: z.string().min(1),
  schemaSha256: digest,
  version: z.literal(1),
});
export type CompiledOperatorReleaseSelection = z.infer<
  typeof compiledOperatorReleaseSelectionSchema
>;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const scoped = (context: OperatorArtifactContext, appSpecDigest: string) => ({
  ...hostedTenantAuthoritySchema.parse(context.authority),
  path: `_protected-operator/selections/generated-release/${appId.parse(context.target.appId)}/${digest.parse(appSpecDigest)}`,
  sessionId: z.string().min(1).parse(context.target.sessionId),
});
const predicate = (scope: ReturnType<typeof scoped>) =>
  and(
    eq(prototypeArtifactChunks.issuer, scope.issuer),
    eq(prototypeArtifactChunks.audience, scope.audience),
    eq(prototypeArtifactChunks.workspaceId, scope.workspaceId),
    eq(prototypeArtifactChunks.ownerUserId, scope.ownerUserId),
    eq(prototypeArtifactChunks.sessionId, scope.sessionId),
    eq(prototypeArtifactChunks.path, scope.path),
    eq(prototypeArtifactChunks.chunkIndex, 0),
  );

/** Completion markers are immutable per trusted tool call and written only after every release member is durably readable. */
export const createPostgresOperatorArtifactSelections = (input: {
  database: PostgresJsDatabase<typeof databaseSchema>;
  assertCurrentOwner: (context: OperatorArtifactContext) => Promise<void>;
}) => ({
  async read(
    context: OperatorArtifactContext,
    appSpecDigest: string,
  ): Promise<CompiledOperatorReleaseSelection | undefined> {
    const scope = scoped(context, appSpecDigest);
    await input.assertCurrentOwner(context);
    const rows = await input.database
      .select({
        chunkDigest: prototypeArtifactChunks.chunkDigest,
        content: prototypeArtifactChunks.content,
      })
      .from(prototypeArtifactChunks)
      .where(predicate(scope))
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
    if (row.chunkDigest !== hash(row.content)) {
      throw operatorArtifactUnavailable();
    }
    const selection = compiledOperatorReleaseSelectionSchema.parse(JSON.parse(row.content));
    if (selection.appId !== context.target.appId || selection.appSpecDigest !== appSpecDigest) {
      throw operatorArtifactUnavailable();
    }
    return selection;
  },
  async record(
    context: OperatorArtifactContext,
    callId: string,
    selectionInput: CompiledOperatorReleaseSelection,
  ) {
    const selection = compiledOperatorReleaseSelectionSchema.parse(selectionInput);
    const scope = scoped(context, selection.appSpecDigest);
    if (
      selection.appId !== context.target.appId ||
      selection.artifactRef.split("/")[2] !== "generated-release" ||
      selection.artifactRef.split("/")[3] !== selection.appId
    ) {
      throw operatorArtifactUnavailable();
    }
    const content = JSON.stringify(selection);
    const transferDigest = hash(z.string().min(1).parse(callId));
    await input.assertCurrentOwner(context);
    await input.database
      .insert(prototypeArtifactChunks)
      .values({
        ...scope,
        chunkDigest: hash(content),
        chunkIndex: 0,
        content,
        createdAt: sql`clock_timestamp()`,
        transferDigest,
      })
      .onConflictDoNothing();
    const rows = await input.database
      .select({
        chunkDigest: prototypeArtifactChunks.chunkDigest,
        content: prototypeArtifactChunks.content,
      })
      .from(prototypeArtifactChunks)
      .where(and(predicate(scope), eq(prototypeArtifactChunks.transferDigest, transferDigest)));
    await input.assertCurrentOwner(context);
    const row = rows.at(0);
    if (row?.content !== content || row.chunkDigest !== hash(content)) {
      throw operatorArtifactUnavailable();
    }
    return selection;
  },
});
