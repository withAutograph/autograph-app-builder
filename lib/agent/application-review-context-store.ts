import { createHash } from "node:crypto";
import { z } from "zod";
import type { OverlayChange, OverlaySnapshot } from "../repository/target-apply";
import type {
  OperatorArtifactContext,
  OperatorArtifactStore,
} from "../provisioning/hosted-operator-artifact-store";
import {
  operatorArtifactReferenceSchema,
  operatorArtifactUnavailable,
} from "../provisioning/hosted-operator-artifact-store";
import { completedSourceAssessmentSchema } from "./product-source-review-journal";
import { sourceReviewBindingDigest } from "./product-source-review";
import type { ProductSourceAssessment, ProductSourceReviewInput } from "./product-source-review";

export interface PreparedApplicationReviewContext {
  version: 1;
  appId: string;
  parentSessionId: string;
  sandboxName: string;
  applyRoot: string;
  observed: OverlaySnapshot;
  normalizedChanges: OverlayChange[];
  visiblePaths: string[];
  reviewKey: string;
  reviewInput: Omit<ProductSourceReviewInput, "files" | "reviewContext">;
}

const text = z.string();
const digest = text.regex(/^[a-f0-9]{64}$/u);
const sourceFile = z.strictObject({ path: text, mode: text, digest: text });
const fileState = z.strictObject({ mode: text, digest: text });
export const preparedApplicationReviewContextSchema = z.strictObject({
  version: z.literal(1),
  appId: text,
  parentSessionId: text,
  sandboxName: text,
  applyRoot: text,
  observed: z.strictObject({ treeDigest: text, files: z.array(sourceFile) }),
  normalizedChanges: z.array(
    z.strictObject({
      path: text,
      kind: z.enum(["added", "modified", "deleted"]),
      before: fileState.optional(),
      after: fileState.optional(),
    }),
  ),
  visiblePaths: z.array(text),
  reviewKey: digest,
  reviewInput: z.strictObject({
    appSpec: text,
    appSpecDigest: text,
    clarifications: z.array(text),
    omissions: z.array(text),
    originalRequest: text.nullable(),
    sourceDigest: text,
  }),
});
const count = z.number().int().nonnegative();
const assessmentSchema = completedSourceAssessmentSchema.extend({
  reviewCompleted: z.boolean(),
  status: z.enum(["failed", "unassessed", "blocked"]),
  invocation: z
    .strictObject({
      requestAttempts: count,
      successfulRequests: count,
      journalReuses: count,
      splits: count,
      requestsWithIncompleteUsage: count,
      freshUsage: z.strictObject({ inputTokens: count, outputTokens: count, totalTokens: count }),
    })
    .optional(),
});
const outcomeSchema = z.strictObject({
  contextRef: text,
  reviewKey: digest,
  assessment: assessmentSchema,
});
const binding = { version: z.literal(1), ownerDigest: digest, appId: text, parentSessionId: text };
const envelopeSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...binding,
    kind: z.literal("context"),
    value: preparedApplicationReviewContextSchema,
  }),
  z.strictObject({ ...binding, kind: z.literal("outcome"), value: outcomeSchema }),
]);
const completionSchema = z.strictObject({
  version: z.literal(1),
  chunkCount: z.number().int().positive(),
  contentBytes: z.number().int().positive(),
});
const chunkCharacters = 65_536;
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const ownerDigest = (context: OperatorArtifactContext) => {
  const authority = context.authority;
  return hash(
    JSON.stringify(
      "kind" in authority
        ? [authority.kind, authority.ownerUid, authority.stateRoot]
        : [authority.issuer, authority.audience, authority.workspaceId, authority.ownerUserId],
    ),
  );
};

/** Private prepared evidence and terminal outcomes; model history belongs to native workflow state. */
export const createApplicationReviewContextStore = (input: {
  store: OperatorArtifactStore;
  context: OperatorArtifactContext;
  assertCurrentOwner: () => Promise<void>;
  abortSignal?: AbortSignal;
}) => {
  const artifactContext: OperatorArtifactContext = {
    authority: { ...input.context.authority },
    target: { ...input.context.target },
  };
  const guard = async () => {
    input.abortSignal?.throwIfAborted();
    await input.assertCurrentOwner();
    input.abortSignal?.throwIfAborted();
  };
  const matches = (value: { appId: string; parentSessionId: string }) => {
    if (
      value.appId !== artifactContext.target.appId ||
      value.parentSessionId !== artifactContext.target.sessionId
    ) {
      throw operatorArtifactUnavailable();
    }
  };
  const readChunk = async (ref: string, index: number) => {
    await guard();
    const content = await input.store.read(artifactContext, ref, index);
    await guard();
    if (content === undefined || content.length === 0) {
      throw operatorArtifactUnavailable();
    }
    return content;
  };
  const reference = (value: string) => {
    const ref = operatorArtifactReferenceSchema.parse(value);
    if (
      ref.split("/")[2] !== "source-review-context" ||
      ref.split("/")[3] !== artifactContext.target.appId
    ) {
      throw operatorArtifactUnavailable();
    }
    return ref;
  };
  const readEnvelope = async (value: string) => {
    await guard();
    const ref = reference(value);
    const completion = completionSchema.parse(JSON.parse(await readChunk(ref, 0)));
    const chunks: string[] = [];
    for (let index = 1; index <= completion.chunkCount; index += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop, react-doctor/async-await-in-loop -- Read every private chunk in transport order, retaining cancellation and owner checks.
      chunks.push(await readChunk(ref, index));
    }
    const encoded = chunks.join("");
    const bytes = Buffer.from(encoded, "base64");
    if (
      bytes.toString("base64") !== encoded ||
      bytes.length !== completion.contentBytes ||
      hash(bytes) !== ref.split("/")[4]
    ) {
      throw operatorArtifactUnavailable();
    }
    const envelope = envelopeSchema.parse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    );
    matches(envelope);
    if (envelope.ownerDigest !== ownerDigest(artifactContext)) {
      throw operatorArtifactUnavailable();
    }
    await guard();
    return envelope;
  };
  const putChunk = async (ref: string, index: number, content: string) => {
    await guard();
    await input.store.put(artifactContext, { artifactRef: ref, chunkIndex: index, content });
    await guard();
    if ((await readChunk(ref, index)) !== content) {
      throw operatorArtifactUnavailable();
    }
  };
  const publish = async (value: z.infer<typeof envelopeSchema>) => {
    await guard();
    const envelope = envelopeSchema.parse(value);
    matches(envelope);
    const content = JSON.stringify(envelope);
    const ref = `_protected-operator/artifacts/source-review-context/${envelope.appId}/${hash(content)}`;
    reference(ref);
    const encoded = Buffer.from(content, "utf-8").toString("base64");
    const chunkCount = Math.ceil(encoded.length / chunkCharacters);
    for (let index = 0; index < chunkCount; index += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop, react-doctor/async-await-in-loop -- Complete and verify each private chunk before the final completion record.
      await putChunk(
        ref,
        index + 1,
        encoded.slice(index * chunkCharacters, (index + 1) * chunkCharacters),
      );
    }
    await putChunk(
      ref,
      0,
      JSON.stringify({ version: 1, chunkCount, contentBytes: Buffer.byteLength(content, "utf-8") }),
    );
    return ref;
  };
  const common = () => ({
    version: 1 as const,
    ownerDigest: ownerDigest(artifactContext),
    appId: artifactContext.target.appId,
    parentSessionId: artifactContext.target.sessionId,
  });
  const readContext = async (ref: string): Promise<PreparedApplicationReviewContext> => {
    const envelope = await readEnvelope(ref);
    if (envelope.kind !== "context") {
      throw operatorArtifactUnavailable();
    }
    matches(envelope.value);
    return envelope.value;
  };
  return {
    async publishContext(value: PreparedApplicationReviewContext): Promise<string> {
      const context = preparedApplicationReviewContextSchema.parse(value);
      matches(context);
      return await publish({ ...common(), kind: "context", value: context });
    },
    readContext,
    async publishOutcome(contextRef: string, assessment: ProductSourceAssessment): Promise<string> {
      const context = await readContext(contextRef);
      const parsed = assessmentSchema.parse(assessment);
      if (parsed.bindingDigest !== sourceReviewBindingDigest(context.reviewInput)) {
        throw operatorArtifactUnavailable();
      }
      return await publish({
        ...common(),
        kind: "outcome",
        value: { contextRef, reviewKey: context.reviewKey, assessment: parsed },
      });
    },
    async readOutcome(
      outcomeRef: string,
    ): Promise<{ contextRef: string; reviewKey: string; assessment: ProductSourceAssessment }> {
      const envelope = await readEnvelope(outcomeRef);
      if (envelope.kind !== "outcome") {
        throw operatorArtifactUnavailable();
      }
      const context = await readContext(envelope.value.contextRef);
      if (
        envelope.value.reviewKey !== context.reviewKey ||
        envelope.value.assessment.bindingDigest !== sourceReviewBindingDigest(context.reviewInput)
      ) {
        throw operatorArtifactUnavailable();
      }
      return envelope.value;
    },
  };
};
