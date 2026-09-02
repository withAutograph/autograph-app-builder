import type { PrototypeArtifact } from "./workflow-state";
import { validateBuildReadyAppSpec } from "./app-spec-validation";
import { sha256, validAppId } from "./workflow-state";

export const prototypeArtifactPathPattern =
  /^prototype\/([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\/(app-spec\.md|decisions\.md|index\.html)$/u;

export const prototypeArtifactMediaTypes = [
  "text/markdown",
  "text/html",
] as const;

export type PrototypeArtifactMediaType =
  (typeof prototypeArtifactMediaTypes)[number];

export type PrototypeArtifactReceipt = Omit<PrototypeArtifact, "content"> & {
  size: number;
};

const maximumArtifactBytes = 262_144;

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
  )
    throw new Error("Prototype artifact path is not allowed.");
  return {
    appId,
    fileName: fileName as "app-spec.md" | "decisions.md" | "index.html",
  };
}

export function expectedPrototypeArtifactMediaType(
  path: string,
): PrototypeArtifactMediaType {
  return parsePrototypeArtifactPath(path).fileName === "index.html"
    ? "text/html"
    : "text/markdown";
}

export function recordPrototypeArtifactRevision(input: {
  artifacts: readonly PrototypeArtifact[];
  path: string;
  mediaType: PrototypeArtifactMediaType;
  content: string;
  sessionId: string;
  callId: string;
  expectedAppId?: string;
}): {
  artifact: PrototypeArtifact;
  artifacts: readonly PrototypeArtifact[];
  reused: boolean;
} {
  const { appId } = parsePrototypeArtifactPath(input.path);
  if (expectedPrototypeArtifactMediaType(input.path) !== input.mediaType)
    throw new Error(
      "Prototype artifact media type is not allowed for its path.",
    );
  if (
    input.content.length === 0 ||
    Buffer.byteLength(input.content) > maximumArtifactBytes
  )
    throw new Error("Prototype artifact content size is not allowed.");
  if (input.expectedAppId !== undefined && appId !== input.expectedAppId)
    throw new Error("Prototype artifact app id does not match this workflow.");
  if (input.artifacts.some(({ sessionId }) => sessionId !== input.sessionId))
    throw new Error("Prototype artifact state belongs to a different session.");
  const recordedAppIds = new Set(
    input.artifacts.map((artifact) => artifact.appId),
  );
  if (recordedAppIds.size > 1)
    throw new Error("Prototype artifact state contains multiple app ids.");
  const recordedAppId = input.artifacts[0]?.appId;
  if (recordedAppId !== undefined && recordedAppId !== appId)
    throw new Error("This app build already owns a different prototype app.");

  const digest = sha256(input.content);
  const revision = sha256(
    JSON.stringify({ path: input.path, mediaType: input.mediaType, digest }),
  );
  const prior = input.artifacts.find(({ path }) => path === input.path);
  if (prior?.revision === revision)
    return { artifact: prior, artifacts: input.artifacts, reused: true };

  const artifact: PrototypeArtifact = {
    appId,
    path: input.path,
    mediaType: input.mediaType,
    content: input.content,
    digest,
    revision,
    sessionId: input.sessionId,
    recordedByCallId: input.callId,
  };
  return {
    artifact,
    artifacts: [
      ...input.artifacts.filter(({ path }) => path !== input.path),
      artifact,
    ].toSorted((left, right) => left.path.localeCompare(right.path)),
    reused: false,
  };
}

export function exactPrototypeArtifact(
  artifacts: readonly PrototypeArtifact[],
  input: {
    path: string;
    digest: string;
    revision?: string;
    sessionId: string;
  },
): PrototypeArtifact {
  parsePrototypeArtifactPath(input.path);
  const artifact = artifacts.find(
    (candidate) =>
      candidate.path === input.path &&
      candidate.digest === input.digest &&
      (input.revision === undefined || candidate.revision === input.revision) &&
      candidate.sessionId === input.sessionId,
  );
  if (artifact === undefined)
    throw new Error(
      "The prototype artifact digest or revision is stale or unavailable in this session.",
    );
  return artifact;
}

export function prototypeArtifactReceipt(
  artifact: PrototypeArtifact,
): PrototypeArtifactReceipt {
  const { content, ...receipt } = artifact;
  return { ...receipt, size: Buffer.byteLength(content) };
}

/**
 * Returns the final AppSpec only when the product has a complete, usable
 * prototype bundle. This is deliberately a content check rather than a
 * workflow-phase check: recording a valid AppSpec must not turn an exploratory
 * draft into accepted planning state.
 */
export function completeBuildReadyPrototypeAppSpec(input: {
  artifacts: readonly PrototypeArtifact[];
  appId: string;
}): PrototypeArtifact | undefined {
  const prefix = `prototype/${input.appId}/`;
  const byPath = new Map(
    input.artifacts
      .filter((artifact) => artifact.path.startsWith(prefix))
      .map((artifact) => [artifact.path, artifact]),
  );
  const appSpec = byPath.get(`${prefix}app-spec.md`);
  if (
    appSpec === undefined ||
    !byPath.has(`${prefix}index.html`) ||
    !byPath.has(`${prefix}decisions.md`) ||
    appSpec.mediaType !== "text/markdown" ||
    !validateBuildReadyAppSpec(appSpec.content).valid
  )
    return undefined;
  return appSpec;
}

export function recordPrototypeArtifactBundle(input: {
  artifacts: readonly PrototypeArtifact[];
  appId: string;
  indexHtml: string;
  decisionsMarkdown: string;
  appSpecMarkdown: string;
  sessionId: string;
  callId: string;
  expectedAppId?: string;
}): {
  artifacts: readonly PrototypeArtifact[];
  appSpec: PrototypeArtifact;
  reused: boolean;
} {
  let artifacts = input.artifacts;
  let reused = true;
  for (const artifact of [
    {
      path: `prototype/${input.appId}/index.html`,
      mediaType: "text/html" as const,
      content: input.indexHtml,
    },
    {
      path: `prototype/${input.appId}/decisions.md`,
      mediaType: "text/markdown" as const,
      content: input.decisionsMarkdown,
    },
    {
      path: `prototype/${input.appId}/app-spec.md`,
      mediaType: "text/markdown" as const,
      content: input.appSpecMarkdown,
    },
  ]) {
    const recorded = recordPrototypeArtifactRevision({
      artifacts,
      ...artifact,
      sessionId: input.sessionId,
      callId: input.callId,
      expectedAppId: input.expectedAppId,
    });
    artifacts = recorded.artifacts;
    reused &&= recorded.reused;
  }
  const appSpec = completeBuildReadyPrototypeAppSpec({
    artifacts,
    appId: input.appId,
  });
  if (appSpec === undefined)
    throw new Error(
      "The prototype bundle must contain a complete build-ready AppSpec.",
    );
  return { artifacts, appSpec, reused };
}
