import { createHash } from "node:crypto";

import type { PrototypeArtifact, StoredPrototypeArtifact } from "./workflow-state";
import {
  appSpecRepairDiagnostic,
  normalizeBuildReadyAppSpec,
  validateBuildReadyAppSpec,
} from "./app-spec-validation";
import { sha256, validAppId } from "./workflow-state";
import {
  EVE_MAX_PAYLOAD_BYTES,
  largestUtf8PayloadChunk,
  serializedPayloadBytes,
} from "../eve/payload-envelope";

export const prototypeArtifactPathPattern =
  // oxlint-disable-next-line prefer-named-capture-group -- Tool JSON Schema validators reject named groups.
  /^prototype\/([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\/(app-spec\.md|decisions\.md|index\.html)$/u;

export const prototypeArtifactMediaTypes = ["text/markdown", "text/html"] as const;

export type PrototypeArtifactMediaType = (typeof prototypeArtifactMediaTypes)[number];

export type PrototypeArtifactReceipt = Omit<
  StoredPrototypeArtifact,
  "content" | "transfer" | "lastChunkReceipt"
> & {
  size: number;
};

export const isPrototypeArtifactV2 = (
  artifact: StoredPrototypeArtifact,
): artifact is Extract<StoredPrototypeArtifact, { version: 2 }> => artifact.version === 2;

/** A v1 completed single-call retry keeps its original receipt and checkpoint shape. */
export const shouldRecordHostedPrototypeDurably = (input: {
  hosted: boolean;
  mediaType: PrototypeArtifactMediaType;
  path: string;
  content: string;
  expectedDigest?: string;
  existing?: StoredPrototypeArtifact;
}): boolean => {
  if (!input.hosted || (input.mediaType !== "text/html" && !input.path.endsWith("/decisions.md"))) {
    return false;
  }
  return !(
    input.expectedDigest === undefined &&
    input.existing !== undefined &&
    !isPrototypeArtifactV2(input.existing) &&
    input.existing.digest === sha256(input.content)
  );
};

interface PrototypeArtifactChunkInput {
  artifacts: readonly StoredPrototypeArtifact[];
  path: string;
  mediaType: PrototypeArtifactMediaType;
  content: string;
  sessionId: string;
  callId: string;
  expectedAppId?: string | null;
  expectedDigest: string;
  chunkIndex: number;
  finalChunk: boolean;
  baseRevision?: string;
}

interface PrototypeArtifactChunkResult {
  artifact: PrototypeArtifact;
  artifacts: readonly StoredPrototypeArtifact[];
  reused: boolean;
  complete: boolean;
  nextChunkIndex: number;
}

const artifactChunkEnvelope = (input: {
  callId: string;
  content: string;
  path: string;
  mediaType: PrototypeArtifactMediaType;
  expectedDigest: string;
  chunkIndex: number;
  finalChunk: boolean;
  baseRevision?: string;
}) => {
  const { callId, content, path, mediaType, expectedDigest, chunkIndex, finalChunk, baseRevision } =
    input;
  const chunkInput = {
    chunkIndex,
    content,
    expectedDigest,
    finalChunk,
    mediaType,
    path,
  };
  if (baseRevision !== undefined) Object.assign(chunkInput, { baseRevision });
  return {
    data: {
      actions: [
        {
          callId,
          input: chunkInput,
          kind: "tool-call",
          toolName: "record_prototype_artifact",
        },
      ],
    },
    type: "actions.requested",
  };
};

const assertArtifactChunkFitsEve = (input: Parameters<typeof artifactChunkEnvelope>[0]) => {
  const size = serializedPayloadBytes(artifactChunkEnvelope(input));
  if (size > EVE_MAX_PAYLOAD_BYTES) {
    throw new Error(
      `Prototype artifact chunk serializes to ${size} bytes, above Eve's ${EVE_MAX_PAYLOAD_BYTES}-byte event envelope. Split the artifact into smaller UTF-8-safe chunks and retry the same chunk index.`,
    );
  }
};

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function parsePrototypeArtifactPath(path: string): {
  appId: string;
  fileName: "app-spec.md" | "decisions.md" | "index.html";
} {
  const match = prototypeArtifactPathPattern.exec(path);
  const appId = match?.[1];
  const fileName = match?.[2];
  if (
    appId === undefined ||
    !validAppId(appId) ||
    !["app-spec.md", "decisions.md", "index.html"].includes(fileName ?? "")
  ) {
    throw new Error("Prototype artifact path is not allowed.");
  }
  return {
    appId,
    fileName: fileName as "app-spec.md" | "decisions.md" | "index.html",
  };
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function expectedPrototypeArtifactMediaType(path: string): PrototypeArtifactMediaType {
  return parsePrototypeArtifactPath(path).fileName === "index.html" ? "text/html" : "text/markdown";
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function recordPrototypeArtifactRevision(input: {
  artifacts: readonly StoredPrototypeArtifact[];
  path: string;
  mediaType: PrototypeArtifactMediaType;
  content: string;
  sessionId: string;
  callId: string;
  expectedAppId?: string | null;
}): {
  artifact: PrototypeArtifact;
  artifacts: readonly StoredPrototypeArtifact[];
  reused: boolean;
} {
  const { appId } = parsePrototypeArtifactPath(input.path);
  if (expectedPrototypeArtifactMediaType(input.path) !== input.mediaType) {
    throw new Error("Prototype artifact media type is not allowed for its path.");
  }
  if (input.content.length === 0) {
    throw new Error("Prototype artifact content must not be empty.");
  }
  if (
    input.expectedAppId !== undefined &&
    input.expectedAppId !== null &&
    appId !== input.expectedAppId
  ) {
    throw new Error("Prototype artifact app id does not match this workflow.");
  }
  if (input.artifacts.some(({ sessionId }) => sessionId !== input.sessionId)) {
    throw new Error("Prototype artifact state belongs to a different session.");
  }
  const recordedAppIds = new Set(input.artifacts.map((artifact) => artifact.appId));
  if (recordedAppIds.size > 1) {
    throw new Error("Prototype artifact state contains multiple app ids.");
  }
  const recordedAppId = input.artifacts[0]?.appId;
  if (recordedAppId !== undefined && recordedAppId !== appId) {
    throw new Error("This app build already owns a different prototype app.");
  }

  const digest = sha256(input.content);
  const revision = sha256(JSON.stringify({ digest, mediaType: input.mediaType, path: input.path }));
  const prior = input.artifacts.find(({ path }) => path === input.path);
  if (prior?.version !== 2 && prior?.revision === revision) {
    return { artifact: prior, artifacts: input.artifacts, reused: true };
  }

  const artifact: PrototypeArtifact = {
    appId,
    content: input.content,
    digest,
    mediaType: input.mediaType,
    path: input.path,
    recordedByCallId: input.callId,
    revision,
    sessionId: input.sessionId,
  };
  return {
    artifact,
    artifacts: [...input.artifacts.filter(({ path }) => path !== input.path), artifact].toSorted(
      (left, right) => left.path.localeCompare(right.path),
    ),
    reused: false,
  };
}

export function exactPrototypeArtifact(
  artifacts: readonly PrototypeArtifact[],
  input: { path: string; digest: string; revision?: string; sessionId: string },
): PrototypeArtifact;
export function exactPrototypeArtifact(
  artifacts: readonly StoredPrototypeArtifact[],
  input: { path: string; digest: string; revision?: string; sessionId: string },
): StoredPrototypeArtifact;
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function exactPrototypeArtifact(
  artifacts: readonly StoredPrototypeArtifact[],
  input: {
    path: string;
    digest: string;
    revision?: string;
    sessionId: string;
  },
): StoredPrototypeArtifact {
  parsePrototypeArtifactPath(input.path);
  const artifact = artifacts.find(
    (candidate) =>
      candidate.path === input.path &&
      candidate.digest === input.digest &&
      candidate.transfer === undefined &&
      (input.revision === undefined || candidate.revision === input.revision) &&
      candidate.sessionId === input.sessionId,
  );
  if (artifact === undefined) {
    throw new Error(
      "The prototype artifact digest or revision is stale or unavailable in this session.",
    );
  }
  return artifact;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function prototypeArtifactReceipt(
  artifact: StoredPrototypeArtifact,
): PrototypeArtifactReceipt {
  if (isPrototypeArtifactV2(artifact)) {
    const { transfer, lastChunkReceipt, ...receipt } = artifact;
    void transfer;
    void lastChunkReceipt;
    return { ...receipt, size: artifact.contentBytes };
  }
  const { content, transfer, lastChunkReceipt, ...receipt } = artifact;
  void lastChunkReceipt;
  return { ...receipt, size: transfer?.receivedBytes ?? Buffer.byteLength(content) };
}

/** Returns a digest-bound UTF-8-safe piece sized by the actual serialized Eve event envelope. */
export const prototypeArtifactReadChunk = (
  artifact: PrototypeArtifact,
  input: { offsetBytes: number },
) => {
  const expectedRevision = sha256(
    JSON.stringify({ digest: artifact.digest, mediaType: artifact.mediaType, path: artifact.path }),
  );
  if (
    artifact.transfer !== undefined ||
    sha256(artifact.content) !== artifact.digest ||
    artifact.revision !== expectedRevision
  ) {
    throw new Error(
      "The prototype artifact is incomplete or its stored content digest is invalid.",
    );
  }
  const totalBytes = Buffer.byteLength(artifact.content, "utf-8");
  return largestUtf8PayloadChunk({
    content: artifact.content,
    makePayload(content, nextOffsetBytes) {
      const output = {
        byteOffset: input.offsetBytes,
        chunkDigest: sha256(content),
        complete: nextOffsetBytes === totalBytes,
        content,
        digest: artifact.digest,
        mediaType: artifact.mediaType,
        nextOffsetBytes,
        path: artifact.path,
        revision: artifact.revision,
        totalBytes,
      };
      return {
        data: {
          result: { kind: "tool-result", output, toolName: "get_prototype_artifact" },
        },
        type: "action.result",
      };
    },
    offsetBytes: input.offsetBytes,
  }).payload.data.result.output;
};

/** Records one ordered, digest-bound part of an artifact without a total-size ceiling. */
const validateArtifactChunkOwnership = (
  input: PrototypeArtifactChunkInput,
  appId: string,
): void => {
  if (expectedPrototypeArtifactMediaType(input.path) !== input.mediaType) {
    throw new Error("Prototype artifact media type is not allowed for its path.");
  }
  if (input.content.length === 0) throw new Error("Prototype artifact chunks must not be empty.");
  if (!/^[a-f0-9]{64}$/u.test(input.expectedDigest)) {
    throw new Error("Prototype artifact expected digest must be a lowercase SHA-256 digest.");
  }
  if (!Number.isSafeInteger(input.chunkIndex) || input.chunkIndex < 0) {
    throw new Error("Prototype artifact chunk index must be a nonnegative safe integer.");
  }
  assertArtifactChunkFitsEve(input);
  if (
    input.expectedAppId !== undefined &&
    input.expectedAppId !== null &&
    appId !== input.expectedAppId
  ) {
    throw new Error("Prototype artifact app id does not match this workflow.");
  }
  if (input.artifacts.some(({ sessionId }) => sessionId !== input.sessionId)) {
    throw new Error("Prototype artifact state belongs to a different session.");
  }
  const recordedAppIds = new Set(input.artifacts.map((artifact) => artifact.appId));
  if (recordedAppIds.size > 1)
    throw new Error("Prototype artifact state contains multiple app ids.");
  const recordedAppId = input.artifacts[0]?.appId;
  if (recordedAppId !== undefined && recordedAppId !== appId) {
    throw new Error("This app build already owns a different prototype app.");
  }
};

type ChunkContinuation =
  | { kind: "retry"; result: PrototypeArtifactChunkResult }
  | { kind: "write"; restart: boolean; transfer?: NonNullable<PrototypeArtifact["transfer"]> };

const pendingChunkRetry = (
  prior: PrototypeArtifact,
  input: PrototypeArtifactChunkInput,
  transfer: NonNullable<PrototypeArtifact["transfer"]>,
  chunkDigest: string,
): PrototypeArtifactChunkResult | undefined => {
  if (
    input.chunkIndex !== transfer.lastChunkIndex ||
    input.callId !== transfer.lastCallId ||
    chunkDigest !== transfer.lastChunkDigest
  ) {
    return undefined;
  }
  return {
    artifact: prior,
    artifacts: input.artifacts,
    complete: false,
    nextChunkIndex: transfer.nextChunkIndex,
    reused: true,
  };
};

const resolveChunkContinuation = (
  prior: PrototypeArtifact | undefined,
  input: PrototypeArtifactChunkInput,
  chunkDigest: string,
): ChunkContinuation => {
  if (
    prior?.transfer === undefined &&
    prior?.lastChunkReceipt?.expectedDigest === input.expectedDigest &&
    prior.lastChunkReceipt.lastChunkIndex === input.chunkIndex &&
    prior.lastChunkReceipt.lastChunkDigest === chunkDigest &&
    prior.lastChunkReceipt.lastCallId === input.callId
  ) {
    return {
      kind: "retry",
      result: {
        artifact: prior,
        artifacts: input.artifacts,
        complete: true,
        nextChunkIndex: input.chunkIndex + 1,
        reused: true,
      },
    };
  }
  const restart =
    prior?.transfer !== undefined &&
    input.chunkIndex === 0 &&
    input.expectedDigest !== prior.transfer.expectedDigest;
  if (prior?.transfer !== undefined && !restart) {
    const { transfer } = prior;
    if (transfer.expectedDigest !== input.expectedDigest) {
      throw new Error(
        "A different prototype artifact transfer is already in progress for this path.",
      );
    }
    const retry = pendingChunkRetry(prior, input, transfer, chunkDigest);
    if (retry !== undefined) return { kind: "retry", result: retry };
    if (input.chunkIndex !== transfer.nextChunkIndex) {
      throw new Error(
        `Prototype artifact chunk ${input.chunkIndex} is out of order; the next required chunk is ${transfer.nextChunkIndex}. Retry the next chunk with the current revision ${prior.revision}.`,
      );
    }
    if (input.baseRevision !== prior.revision) {
      throw new Error(
        "Prototype artifact chunk base revision is stale; read the latest transfer receipt and retry.",
      );
    }
    return { kind: "write", restart, transfer };
  }
  if (input.chunkIndex !== 0)
    throw new Error("Prototype artifact transfer must start with chunk 0.");
  return { kind: "write", restart };
};

const artifactForCompletedChunk = (
  input: PrototypeArtifactChunkInput,
  appId: string,
  chunks: readonly string[],
  chunkDigest: string,
): PrototypeArtifactChunkResult => {
  const contentHash = createHash("sha256");
  for (const chunk of chunks) contentHash.update(chunk, "utf-8");
  const digest = contentHash.digest("hex");
  if (digest !== input.expectedDigest) {
    throw new Error(
      "Final prototype artifact chunk does not match the expected full-content digest.",
    );
  }
  const content = chunks.join("");
  const revision = sha256(JSON.stringify({ digest, mediaType: input.mediaType, path: input.path }));
  const artifact: PrototypeArtifact = {
    appId,
    content,
    digest,
    lastChunkReceipt: {
      expectedDigest: input.expectedDigest,
      lastCallId: input.callId,
      lastChunkDigest: chunkDigest,
      lastChunkIndex: input.chunkIndex,
    },
    mediaType: input.mediaType,
    path: input.path,
    recordedByCallId: input.callId,
    revision,
    sessionId: input.sessionId,
  };
  const artifacts = [
    ...input.artifacts.filter(({ path }) => path !== input.path),
    artifact,
  ].toSorted((left, right) => left.path.localeCompare(right.path));
  return {
    artifact,
    artifacts,
    complete: true,
    nextChunkIndex: input.chunkIndex + 1,
    reused: false,
  };
};

const artifactForPendingChunk = (
  input: PrototypeArtifactChunkInput,
  appId: string,
  chunks: readonly string[],
  priorTransfer: NonNullable<PrototypeArtifact["transfer"]> | undefined,
  restart: boolean,
  chunkDigest: string,
): PrototypeArtifactChunkResult => {
  const rollingDigest = sha256(`${priorTransfer?.rollingDigest ?? ""}${chunkDigest}`);
  const receivedBytes =
    (restart ? 0 : (priorTransfer?.receivedBytes ?? 0)) + Buffer.byteLength(input.content, "utf-8");
  const transfer = {
    chunks,
    expectedDigest: input.expectedDigest,
    lastCallId: input.callId,
    lastChunkDigest: chunkDigest,
    lastChunkIndex: input.chunkIndex,
    nextChunkIndex: input.chunkIndex + 1,
    receivedBytes,
    rollingDigest,
  } as const;
  const revision = sha256(
    JSON.stringify({
      digest: rollingDigest,
      mediaType: input.mediaType,
      path: input.path,
      transfer,
    }),
  );
  const artifact: PrototypeArtifact = {
    appId,
    content: "",
    digest: rollingDigest,
    mediaType: input.mediaType,
    path: input.path,
    recordedByCallId: input.callId,
    revision,
    sessionId: input.sessionId,
    transfer,
  };
  const artifacts = [
    ...input.artifacts.filter(({ path }) => path !== input.path),
    artifact,
  ].toSorted((left, right) => left.path.localeCompare(right.path));
  return {
    artifact,
    artifacts,
    complete: false,
    nextChunkIndex: transfer.nextChunkIndex,
    reused: false,
  };
};

export const recordPrototypeArtifactChunk = (
  input: PrototypeArtifactChunkInput,
): PrototypeArtifactChunkResult => {
  const { appId } = parsePrototypeArtifactPath(input.path);
  validateArtifactChunkOwnership(input, appId);
  const prior = input.artifacts.find(({ path }) => path === input.path);
  if (prior && isPrototypeArtifactV2(prior)) {
    throw new Error("This artifact uses durable chunks; read its current receipt before retrying.");
  }
  const chunkDigest = sha256(input.content);
  const continuation = resolveChunkContinuation(prior, input, chunkDigest);
  if (continuation.kind === "retry") return continuation.result;
  const { restart, transfer } = continuation;
  const chunks =
    transfer === undefined || restart ? [input.content] : [...transfer.chunks, input.content];
  if (input.finalChunk) {
    return artifactForCompletedChunk(input, appId, chunks, chunkDigest);
  }
  return artifactForPendingChunk(input, appId, chunks, transfer, restart, chunkDigest);
};

/**
 * Returns the final AppSpec only when the product has a complete, usable
 * prototype bundle. This is deliberately a content check rather than a
 * workflow-phase check: recording a valid AppSpec must not turn an exploratory
 * draft into accepted planning state.
 */
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function completeBuildReadyPrototypeAppSpec(input: {
  artifacts: readonly StoredPrototypeArtifact[];
  appId: string;
}): PrototypeArtifact | undefined {
  const prefix = `prototype/${input.appId}/`;
  const byPath = new Map(
    input.artifacts
      .filter((artifact) => artifact.path.startsWith(prefix))
      .filter((artifact) => artifact.transfer === undefined)
      .map((artifact) => [artifact.path, artifact]),
  );
  const appSpec = byPath.get(`${prefix}app-spec.md`);
  if (
    appSpec === undefined ||
    !byPath.has(`${prefix}index.html`) ||
    !byPath.has(`${prefix}decisions.md`) ||
    appSpec.mediaType !== "text/markdown" ||
    isPrototypeArtifactV2(appSpec) ||
    !validateBuildReadyAppSpec(appSpec.content).valid
  ) {
    return undefined;
  }
  return appSpec;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function recordPrototypeArtifactBundle(input: {
  artifacts: readonly StoredPrototypeArtifact[];
  appId: string;
  indexHtml: string;
  decisionsMarkdown: string;
  appSpecMarkdown: string;
  sessionId: string;
  callId: string;
  expectedAppId?: string;
}): {
  artifacts: readonly StoredPrototypeArtifact[];
  appSpec: PrototypeArtifact;
  reused: boolean;
} {
  const appSpecMarkdown = normalizeBuildReadyAppSpec(input.appSpecMarkdown);
  let { artifacts } = input;
  let reused = true;
  for (const artifact of [
    {
      content: input.indexHtml,
      mediaType: "text/html" as const,
      path: `prototype/${input.appId}/index.html`,
    },
    {
      content: input.decisionsMarkdown,
      mediaType: "text/markdown" as const,
      path: `prototype/${input.appId}/decisions.md`,
    },
    {
      content: appSpecMarkdown,
      mediaType: "text/markdown" as const,
      path: `prototype/${input.appId}/app-spec.md`,
    },
  ]) {
    const recorded = recordPrototypeArtifactRevision({
      artifacts,
      ...artifact,
      callId: input.callId,
      expectedAppId: input.expectedAppId,
      sessionId: input.sessionId,
    });
    ({ artifacts } = recorded);
    reused &&= recorded.reused;
  }
  const appSpec = completeBuildReadyPrototypeAppSpec({
    appId: input.appId,
    artifacts,
  });
  if (appSpec === undefined) {
    const validation = validateBuildReadyAppSpec(appSpecMarkdown);
    if (!validation.valid) {
      throw new Error(appSpecRepairDiagnostic(validation));
    }
    throw new Error("The prototype bundle must contain a complete build-ready AppSpec.");
  }
  return { appSpec, artifacts, reused };
}
