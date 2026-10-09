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
import type {
  OperatorArtifactContext,
  OperatorArtifactStore,
} from "./hosted-operator-artifact-store";
import { createOperatorArtifactPublication } from "./hosted-operator-artifacts";

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
export const exactCompiledOperatorReleaseLookupSchema = z.union([
  z.strictObject({
    appSpecDigest: digest.optional(),
    artifactRef: operatorArtifactReferenceSchema,
  }),
  z.strictObject({
    appSpecDigest: digest.optional(),
    manifestSha256: digest.optional(),
    releaseId: z.string().min(1),
    schemaSha256: digest,
  }),
]);
export type ExactCompiledOperatorReleaseLookup = z.infer<
  typeof exactCompiledOperatorReleaseLookupSchema
>;

/** Match actual retained identity, never a latest/earliest version inferred from source. */
export const matchesExactCompiledOperatorRelease = (
  selection: CompiledOperatorReleaseSelection,
  lookup: ExactCompiledOperatorReleaseLookup,
) => {
  if (lookup.appSpecDigest !== undefined && selection.appSpecDigest !== lookup.appSpecDigest) {
    return false;
  }
  if ("artifactRef" in lookup) {
    return selection.artifactRef === lookup.artifactRef;
  }
  return (
    selection.releaseId === lookup.releaseId &&
    selection.schemaSha256 === lookup.schemaSha256 &&
    (lookup.manifestSha256 === undefined || selection.manifestSha256 === lookup.manifestSha256)
  );
};

export const selectExactCompiledOperatorRelease = (
  selections: readonly CompiledOperatorReleaseSelection[],
  lookupInput: ExactCompiledOperatorReleaseLookup,
): CompiledOperatorReleaseSelection | undefined => {
  const lookup = exactCompiledOperatorReleaseLookupSchema.parse(lookupInput);
  let matched: CompiledOperatorReleaseSelection | undefined;
  for (const input of selections) {
    const selection = compiledOperatorReleaseSelectionSchema.parse(input);
    if (!matchesExactCompiledOperatorRelease(selection, lookup)) {
      continue;
    }
    if (matched !== undefined) {
      const sameArtifact = [
        matched.artifactRef === selection.artifactRef,
        matched.manifestSha256 === selection.manifestSha256,
        matched.releaseId === selection.releaseId,
        matched.schemaSha256 === selection.schemaSha256,
        matched.appId === selection.appId,
      ].every(Boolean);
      if (!sameArtifact) {
        throw operatorArtifactUnavailable();
      }
    }
    // Repeated accepted specs can retain the same content-addressed artifact.
    // Return a real equivalent completion marker, never another version.
    if (matched === undefined || selection.appSpecDigest < matched.appSpecDigest) {
      matched = selection;
    }
  }
  return matched;
};
export interface OperatorArtifactSelections {
  read: (
    context: OperatorArtifactContext,
    appSpecDigest: string,
  ) => Promise<CompiledOperatorReleaseSelection | undefined>;
  /** Optional for legacy writers; supported hosted/local stores retain exact historical markers. */
  readExact?: (
    context: OperatorArtifactContext,
    lookup: ExactCompiledOperatorReleaseLookup,
  ) => Promise<CompiledOperatorReleaseSelection | undefined>;
  record: (
    context: OperatorArtifactContext,
    callId: string,
    selection: CompiledOperatorReleaseSelection,
  ) => Promise<CompiledOperatorReleaseSelection>;
}
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
}): OperatorArtifactSelections => ({
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
  async readExact(context, lookupInput) {
    const lookup = exactCompiledOperatorReleaseLookupSchema.parse(lookupInput);
    const authority = hostedTenantAuthoritySchema.parse(context.authority);
    const selectedApp = appId.parse(context.target.appId);
    const sessionId = z.string().min(1).parse(context.target.sessionId);
    const pathPrefix = `_protected-operator/selections/generated-release/${selectedApp}/`;
    if (
      "artifactRef" in lookup &&
      (lookup.artifactRef.split("/")[2] !== "generated-release" ||
        lookup.artifactRef.split("/")[3] !== selectedApp)
    ) {
      throw operatorArtifactUnavailable();
    }
    await input.assertCurrentOwner(context);
    const identity =
      "artifactRef" in lookup
        ? sql`${prototypeArtifactChunks.content}::jsonb ->> 'artifactRef' = ${lookup.artifactRef}`
        : and(
            sql`${prototypeArtifactChunks.content}::jsonb ->> 'releaseId' = ${lookup.releaseId}`,
            sql`${prototypeArtifactChunks.content}::jsonb ->> 'schemaSha256' = ${lookup.schemaSha256}`,
          );
    const rows = await input.database
      .select({
        chunkDigest: prototypeArtifactChunks.chunkDigest,
        content: prototypeArtifactChunks.content,
        path: prototypeArtifactChunks.path,
      })
      .from(prototypeArtifactChunks)
      .where(
        and(
          eq(prototypeArtifactChunks.issuer, authority.issuer),
          eq(prototypeArtifactChunks.audience, authority.audience),
          eq(prototypeArtifactChunks.workspaceId, authority.workspaceId),
          eq(prototypeArtifactChunks.ownerUserId, authority.ownerUserId),
          eq(prototypeArtifactChunks.sessionId, sessionId),
          eq(prototypeArtifactChunks.chunkIndex, 0),
          sql`left(${prototypeArtifactChunks.path}, ${pathPrefix.length}) = ${pathPrefix}`,
          identity,
        ),
      );
    await input.assertCurrentOwner(context);
    const selections = rows.map((row) => {
      if (row.chunkDigest !== hash(row.content)) {
        throw operatorArtifactUnavailable();
      }
      const selection = compiledOperatorReleaseSelectionSchema.parse(JSON.parse(row.content));
      if (
        selection.appId !== selectedApp ||
        row.path !== `${pathPrefix}${selection.appSpecDigest}`
      ) {
        throw operatorArtifactUnavailable();
      }
      return selection;
    });
    return selectExactCompiledOperatorRelease(selections, lookup);
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

/** The caller supplies a freshly authorized capture-session context, including any trusted durable lineage resolution. */
export const readExactCompiledOperatorRelease = async (input: {
  assertCurrentOwner: (context: OperatorArtifactContext) => Promise<void>;
  context: OperatorArtifactContext;
  lookup: ExactCompiledOperatorReleaseLookup;
  selections: OperatorArtifactSelections;
  store: OperatorArtifactStore;
}) => {
  const lookup = exactCompiledOperatorReleaseLookupSchema.parse(input.lookup);
  if (input.selections.readExact === undefined) {
    throw operatorArtifactUnavailable();
  }
  await input.assertCurrentOwner(input.context);
  const selection = await input.selections.readExact(input.context, lookup);
  await input.assertCurrentOwner(input.context);
  if (selection === undefined) {
    // oxlint-disable-next-line unicorn/no-useless-undefined -- Absence is the explicit optional historical read contract.
    return undefined;
  }
  if (
    selection.appId !== input.context.target.appId ||
    !matchesExactCompiledOperatorRelease(selection, lookup)
  ) {
    throw operatorArtifactUnavailable();
  }
  const publication = createOperatorArtifactPublication({
    assertCurrentOwner: input.assertCurrentOwner,
    store: input.store,
  });
  const { files } = await publication.readGeneratedRelease(input.context, selection);
  await input.assertCurrentOwner(input.context);
  return { files, selection };
};
