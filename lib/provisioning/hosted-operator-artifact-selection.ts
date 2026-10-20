import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
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
export const publishedAppSourceSchema = z.object({
  branch: z.string().min(1),
  changeSetDigest: digest,
  gitSha: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u),
  gitTree: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u),
  repositoryId: z.string().min(1),
  reviewDigest: digest,
});
export type PublishedAppSource = z.infer<typeof publishedAppSourceSchema>;
export type PublishedAppSourceLookup = Pick<
  PublishedAppSource,
  "repositoryId" | "branch" | "gitSha" | "gitTree"
>;
export const publishedAppSourceLookupSchema = publishedAppSourceSchema.pick({
  repositoryId: true,
  branch: true,
  gitSha: true,
  gitTree: true,
});
export const compiledOperatorReleaseSelectionSchema = z.object({
  appId,
  appSpecDigest: digest,
  artifactRef: operatorArtifactReferenceSchema,
  manifestSha256: digest,
  publishedSource: publishedAppSourceSchema.optional(),
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
/** An exact recorded publication is usable across accepted specifications of the same owned app. */
export const selectExactPublishedAppSource = (
  selections: readonly CompiledOperatorReleaseSelection[],
  lookupInput: PublishedAppSourceLookup,
): PublishedAppSource | undefined => {
  const lookup = publishedAppSourceLookupSchema.parse(lookupInput);
  const parsed = selections.map((selection) =>
    compiledOperatorReleaseSelectionSchema.parse(selection),
  );
  return parsed
    .map((selection) => selection.publishedSource)
    .find(
      (source) =>
        source !== undefined &&
        [
          source.repositoryId === lookup.repositoryId,
          source.branch === lookup.branch,
          source.gitSha === lookup.gitSha,
          source.gitTree === lookup.gitTree,
        ].every(Boolean),
    );
};

/** Publication metadata does not change the identity of an already captured release. */
export const isEquivalentCompiledOperatorRelease = (
  left: CompiledOperatorReleaseSelection,
  right: CompiledOperatorReleaseSelection,
): boolean => {
  const first = { ...compiledOperatorReleaseSelectionSchema.parse(left) };
  const second = { ...compiledOperatorReleaseSelectionSchema.parse(right) };
  delete first.publishedSource;
  delete second.publishedSource;
  return isDeepStrictEqual(first, second);
};
export interface PublishedSourceAssociation {
  approvedSelection: Omit<CompiledOperatorReleaseSelection, "publishedSource">;
  publishedSource: PublishedAppSource;
  operationId: string;
}
export type PublishedSourceAssociationResult =
  | { status: "recorded"; selection: CompiledOperatorReleaseSelection }
  | { status: "selection-changed" };

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
  readPublishedSource?: (
    context: OperatorArtifactContext,
    lookup: PublishedAppSourceLookup,
  ) => Promise<PublishedAppSource | undefined>;
  /** Append only to the exact current equivalent capture; legacy stores cannot perform this recovery. */
  associatePublishedSource?: (
    context: OperatorArtifactContext,
    input: PublishedSourceAssociation,
  ) => Promise<PublishedSourceAssociationResult>;
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
}): OperatorArtifactSelections => {
  // Every selection writer shares this lock, so recovery cannot hide a concurrent capture.
  const writeSelection = async <T>(
    context: OperatorArtifactContext,
    scope: ReturnType<typeof scoped>,
    write: (
      database: Pick<PostgresJsDatabase<typeof databaseSchema>, "select" | "insert">,
    ) => Promise<T>,
  ): Promise<T> => {
    await input.assertCurrentOwner(context);
    return await input.database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${hash(JSON.stringify(scope))}, 0))`,
      );
      await input.assertCurrentOwner(context);
      const result = await write(transaction);
      await input.assertCurrentOwner(context);
      return result;
    });
  };
  const nextCreatedAt = (scope: ReturnType<typeof scoped>) =>
    sql`greatest(clock_timestamp(), (select max(${prototypeArtifactChunks.createdAt}) + interval '1 microsecond' from ${prototypeArtifactChunks} where ${predicate(scope)}))`;
  return {
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
    async readPublishedSource(context, lookupInput) {
      const lookup = publishedAppSourceLookupSchema.parse(lookupInput);
      const authority = hostedTenantAuthoritySchema.parse(context.authority);
      const selectedApp = appId.parse(context.target.appId);
      const sessionId = z.string().min(1).parse(context.target.sessionId);
      const pathPrefix = `_protected-operator/selections/generated-release/${selectedApp}/`;
      // SQL may reorder AND terms; unrelated prototype rows can contain HTML.
      const publishedSource = sql`case when left(${prototypeArtifactChunks.path}, ${pathPrefix.length}) = ${pathPrefix} then ${prototypeArtifactChunks.content}::jsonb -> 'publishedSource' end`;
      await input.assertCurrentOwner(context);
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
            sql`(${publishedSource}) ->> 'repositoryId' = ${lookup.repositoryId}`,
            sql`(${publishedSource}) ->> 'branch' = ${lookup.branch}`,
            sql`(${publishedSource}) ->> 'gitSha' = ${lookup.gitSha}`,
            sql`(${publishedSource}) ->> 'gitTree' = ${lookup.gitTree}`,
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
      return selectExactPublishedAppSource(selections, lookup);
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
      return await writeSelection(context, scope, async (database) => {
        await database
          .insert(prototypeArtifactChunks)
          .values({
            ...scope,
            chunkDigest: hash(content),
            chunkIndex: 0,
            content,
            createdAt: nextCreatedAt(scope),
            transferDigest,
          })
          .onConflictDoNothing();
        const rows = await database
          .select({
            chunkDigest: prototypeArtifactChunks.chunkDigest,
            content: prototypeArtifactChunks.content,
          })
          .from(prototypeArtifactChunks)
          .where(and(predicate(scope), eq(prototypeArtifactChunks.transferDigest, transferDigest)));
        const row = rows.at(0);
        if (row?.content !== content || row.chunkDigest !== hash(content)) {
          throw operatorArtifactUnavailable();
        }
        return selection;
      });
    },
    async associatePublishedSource(context, association) {
      const approved = compiledOperatorReleaseSelectionSchema.parse(association.approvedSelection);
      const source = publishedAppSourceSchema.parse(association.publishedSource);
      const operationId = z.string().min(1).parse(association.operationId);
      if (approved.appId !== context.target.appId) {
        throw operatorArtifactUnavailable();
      }
      const scope = scoped(context, approved.appSpecDigest);
      return await writeSelection(
        context,
        scope,
        async (database): Promise<PublishedSourceAssociationResult> => {
          const [latest] = await database
            .select({
              content: prototypeArtifactChunks.content,
              chunkDigest: prototypeArtifactChunks.chunkDigest,
              transferDigest: prototypeArtifactChunks.transferDigest,
            })
            .from(prototypeArtifactChunks)
            .where(predicate(scope))
            .orderBy(
              desc(prototypeArtifactChunks.createdAt),
              desc(prototypeArtifactChunks.transferDigest),
            )
            .limit(1);
          if (latest === undefined) {
            return { status: "selection-changed" };
          }
          if (latest.chunkDigest !== hash(latest.content)) {
            throw operatorArtifactUnavailable();
          }
          const current = compiledOperatorReleaseSelectionSchema.parse(JSON.parse(latest.content));
          if (!isEquivalentCompiledOperatorRelease(current, approved)) {
            return { status: "selection-changed" };
          }
          if (current.publishedSource !== undefined) {
            return isDeepStrictEqual(current.publishedSource, source)
              ? { status: "recorded", selection: current }
              : { status: "selection-changed" };
          }
          const selection = { ...current, publishedSource: source };
          const content = JSON.stringify(selection);
          const transferDigest = hash(`source-association:${operationId}:${latest.transferDigest}`);
          await database
            .insert(prototypeArtifactChunks)
            .values({
              ...scope,
              chunkIndex: 0,
              content,
              chunkDigest: hash(content),
              createdAt: nextCreatedAt(scope),
              transferDigest,
            })
            .onConflictDoNothing();
          const [recorded] = await database
            .select({
              content: prototypeArtifactChunks.content,
              chunkDigest: prototypeArtifactChunks.chunkDigest,
            })
            .from(prototypeArtifactChunks)
            .where(
              and(predicate(scope), eq(prototypeArtifactChunks.transferDigest, transferDigest)),
            );
          if (recorded?.content !== content || recorded.chunkDigest !== hash(content)) {
            throw operatorArtifactUnavailable();
          }
          return { status: "recorded", selection };
        },
      );
    },
  };
};

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
