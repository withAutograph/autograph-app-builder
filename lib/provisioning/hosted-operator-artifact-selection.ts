import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { HostedDatabase } from "../db/hosted-postgres";
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

const selectionChangedStatus = "selection-changed";

const GENERATED_RELEASE_KIND = "generated-release";
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
/** Destination evidence for every app backend, recorded only after trusted publication succeeds. */
export const appPublicationDestinationSchema = z.object({
  version: z.literal(1),
  appId,
  appSpecDigest: digest,
  publishedSource: publishedAppSourceSchema,
});
export type AppPublicationDestination = z.infer<typeof appPublicationDestinationSchema>;
export type AppPublicationSelectionMode = "initial" | "current";
/** A retained initial result must not overwrite a later head on that same publication branch. */
export const historicalAppPublication = (
  mode: AppPublicationSelectionMode,
  destination: AppPublicationDestination,
  current: AppPublicationDestination | undefined,
) =>
  mode === "initial" &&
  current?.publishedSource.repositoryId === destination.publishedSource.repositoryId &&
  current.publishedSource.branch === destination.publishedSource.branch;

const publicationDestinationForStorage = (
  mode: AppPublicationSelectionMode,
  destination: AppPublicationDestination,
  current: AppPublicationDestination | undefined,
): AppPublicationDestination & { historicalOnly?: true } => {
  const stored: AppPublicationDestination & { historicalOnly?: true } = { ...destination };
  if (historicalAppPublication(mode, destination, current)) {
    stored.historicalOnly = true;
  }
  return stored;
};

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
    publishedSource: publishedAppSourceLookupSchema.omit({ gitTree: true }).optional(),
    artifactRef: operatorArtifactReferenceSchema,
  }),
  z.strictObject({
    appSpecDigest: digest.optional(),
    publishedSource: publishedAppSourceLookupSchema.omit({ gitTree: true }).optional(),
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
  if (lookup.publishedSource !== undefined) {
    const source = selection.publishedSource;
    if (
      source === undefined ||
      source.repositoryId !== lookup.publishedSource.repositoryId ||
      source.branch !== lookup.publishedSource.branch ||
      source.gitSha !== lookup.publishedSource.gitSha
    ) {
      return false;
    }
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
  selections: readonly (CompiledOperatorReleaseSelection | AppPublicationDestination)[],
  lookupInput: PublishedAppSourceLookup,
): PublishedAppSource | undefined => {
  const lookup = publishedAppSourceLookupSchema.parse(lookupInput);
  const parsed = selections.map((selection) =>
    ("artifactRef" in selection
      ? compiledOperatorReleaseSelectionSchema
      : appPublicationDestinationSchema
    ).parse(selection),
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
  readDestination?: (
    context: OperatorArtifactContext,
    appSpecDigest: string,
  ) => Promise<AppPublicationDestination | undefined>;
  recordDestination?: (
    context: OperatorArtifactContext,
    callId: string,
    destination: AppPublicationDestination,
    /** Initial results are scoped to the currently approved publication branch. */
    selectionMode: AppPublicationSelectionMode,
  ) => Promise<AppPublicationDestination>;

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
const scoped = (
  context: OperatorArtifactContext,
  appSpecDigest: string,
  kind: "generated-release" | "app-publication" = GENERATED_RELEASE_KIND,
) => ({
  ...hostedTenantAuthoritySchema.parse(context.authority),
  path: `_protected-operator/selections/${kind}/${appId.parse(context.target.appId)}/${digest.parse(appSpecDigest)}`,
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

const selectedDestinationPredicate = (scope: ReturnType<typeof scoped>) =>
  and(
    predicate(scope),
    // Other artifact rows contain HTML; SQL may evaluate AND terms in any order.
    sql`(case when ${predicate(scope)} then ${prototypeArtifactChunks.content}::jsonb->>'historicalOnly' end) is distinct from 'true'`,
  );

/** Completion markers are immutable per trusted tool call and written only after every release member is durably readable. */
export const createPostgresOperatorArtifactSelections = (input: {
  database: HostedDatabase;
  assertCurrentOwner: (context: OperatorArtifactContext) => Promise<void>;
}): OperatorArtifactSelections => {
  // Every selection writer shares this lock, so recovery cannot hide a concurrent capture.
  const writeSelection = async <T>(
    context: OperatorArtifactContext,
    scope: ReturnType<typeof scoped>,
    write: (database: Pick<HostedDatabase, "select" | "insert">) => Promise<T>,
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
    async readDestination(context, appSpecDigest) {
      const scope = scoped(context, appSpecDigest, "app-publication");
      await input.assertCurrentOwner(context);
      const [row] = await input.database
        .select({
          content: prototypeArtifactChunks.content,
          chunkDigest: prototypeArtifactChunks.chunkDigest,
        })
        .from(prototypeArtifactChunks)
        .where(selectedDestinationPredicate(scope))
        .orderBy(
          desc(prototypeArtifactChunks.createdAt),
          desc(prototypeArtifactChunks.transferDigest),
        )
        .limit(1);
      await input.assertCurrentOwner(context);
      if (row === undefined) {
        // oxlint-disable-next-line unicorn/no-useless-undefined -- Missing owned destination is the optional store read result.
        return undefined;
      }
      if (row.chunkDigest !== hash(row.content)) {
        throw operatorArtifactUnavailable();
      }
      const destination = appPublicationDestinationSchema.parse(JSON.parse(row.content));
      if (
        destination.appId !== context.target.appId ||
        destination.appSpecDigest !== appSpecDigest
      ) {
        throw operatorArtifactUnavailable();
      }
      return destination;
    },
    async recordDestination(context, callId, value, selectionMode) {
      const destination = appPublicationDestinationSchema.parse(value);
      if (destination.appId !== context.target.appId) {
        throw operatorArtifactUnavailable();
      }
      const scope = scoped(context, destination.appSpecDigest, "app-publication");
      const transferDigest = hash(z.string().min(1).parse(callId));
      return await writeSelection(context, scope, async (database) => {
        const [prior] = await database
          .select({
            content: prototypeArtifactChunks.content,
            chunkDigest: prototypeArtifactChunks.chunkDigest,
          })
          .from(prototypeArtifactChunks)
          .where(selectedDestinationPredicate(scope))
          .orderBy(
            desc(prototypeArtifactChunks.createdAt),
            desc(prototypeArtifactChunks.transferDigest),
          )
          .limit(1);
        if (prior !== undefined && prior.chunkDigest !== hash(prior.content)) {
          throw operatorArtifactUnavailable();
        }
        const current =
          prior === undefined
            ? undefined
            : appPublicationDestinationSchema.parse(JSON.parse(prior.content));
        // A new currently selected proposal has its own sealed branch. Recovery
        // can retain its initial receipt, but cannot undo a same-branch reconciliation.
        const content = JSON.stringify(
          publicationDestinationForStorage(selectionMode, destination, current),
        );
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
        const [row] = await database
          .select({
            content: prototypeArtifactChunks.content,
            chunkDigest: prototypeArtifactChunks.chunkDigest,
          })
          .from(prototypeArtifactChunks)
          .where(and(predicate(scope), eq(prototypeArtifactChunks.transferDigest, transferDigest)));
        if (
          row === undefined ||
          row.chunkDigest !== hash(row.content) ||
          !isDeepStrictEqual(
            appPublicationDestinationSchema.parse(JSON.parse(row.content)),
            destination,
          )
        ) {
          throw operatorArtifactUnavailable();
        }
        return destination;
      });
    },
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
        (lookup.artifactRef.split("/")[2] !== GENERATED_RELEASE_KIND ||
          lookup.artifactRef.split("/")[3] !== selectedApp)
      ) {
        throw operatorArtifactUnavailable();
      }
      await input.assertCurrentOwner(context);
      const ownedPath = sql`left(${prototypeArtifactChunks.path}, ${pathPrefix.length}) = ${pathPrefix}`;
      // SQL may reorder AND terms; unrelated prototype rows can contain HTML.
      const selectedContent = sql`case when ${ownedPath} then ${prototypeArtifactChunks.content}::jsonb end`;
      const identity =
        "artifactRef" in lookup
          ? sql`(${selectedContent}) ->> 'artifactRef' = ${lookup.artifactRef}`
          : and(
              sql`(${selectedContent}) ->> 'releaseId' = ${lookup.releaseId}`,
              sql`(${selectedContent}) ->> 'schemaSha256' = ${lookup.schemaSha256}`,
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
            ownedPath,
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
      const destinationPrefix = `_protected-operator/selections/app-publication/${selectedApp}/`;
      const ownedPath = sql`(left(${prototypeArtifactChunks.path}, ${pathPrefix.length}) = ${pathPrefix} or left(${prototypeArtifactChunks.path}, ${destinationPrefix.length}) = ${destinationPrefix})`;
      // SQL may reorder AND terms; unrelated prototype rows can contain HTML.
      const publishedSource = sql`case when ${ownedPath} then ${prototypeArtifactChunks.content}::jsonb -> 'publishedSource' end`;
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
            ownedPath,
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
        const isDestination = row.path.startsWith(destinationPrefix);
        const selection = (
          isDestination ? appPublicationDestinationSchema : compiledOperatorReleaseSelectionSchema
        ).parse(JSON.parse(row.content));
        if (
          selection.appId !== selectedApp ||
          row.path !== `${isDestination ? destinationPrefix : pathPrefix}${selection.appSpecDigest}`
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
        selection.artifactRef.split("/")[2] !== GENERATED_RELEASE_KIND ||
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
            return { status: selectionChangedStatus };
          }
          if (latest.chunkDigest !== hash(latest.content)) {
            throw operatorArtifactUnavailable();
          }
          const current = compiledOperatorReleaseSelectionSchema.parse(JSON.parse(latest.content));
          if (!isEquivalentCompiledOperatorRelease(current, approved)) {
            return { status: selectionChangedStatus };
          }
          if (current.publishedSource !== undefined) {
            return isDeepStrictEqual(current.publishedSource, source)
              ? { status: "recorded", selection: current }
              : { status: selectionChangedStatus };
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
