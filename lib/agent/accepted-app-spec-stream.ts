import { createHash } from "node:crypto";

import type { AcceptedAppSpec, PrototypeArtifactV2 } from "./workflow-state";
import type { ReadPrototypeChunk } from "./prototype-artifact-stream";
import { verifyPrototypeArtifactManifest } from "./prototype-artifact-stream";
import {
  BUILD_READY_HANDOFF_EXAMPLE,
  REQUIRED_APP_SPEC_HEADINGS,
  buildReadyHandoffSchema,
} from "./app-spec-validation";

const canonicalBuildHandoff = `## Build handoff\n\n\`\`\`json\n${JSON.stringify(BUILD_READY_HANDOFF_EXAMPLE, null, 2)}\n\`\`\``;
// The heading line is consumed by the streaming heading scanner, so the
// remaining bytes begin with the blank line before the fenced JSON block.
const canonicalHandoff = canonicalBuildHandoff.slice("## Build handoff\n".length);
const maxHandoffDiagnosticLength = 64 * 1024;
const buildHandoffHeading = "Build handoff";
interface RepairIssue {
  message: string;
  path: string;
}
const headingNames = new Set<string>(REQUIRED_APP_SPEC_HEADINGS);
const maxHeadingLength =
  Math.max(...REQUIRED_APP_SPEC_HEADINGS.map((heading) => heading.length)) + 3;

const diagnoseHandoff = (handoff: string, truncated: boolean): RepairIssue[] => {
  if (truncated) {
    return [
      {
        message:
          "The handoff is too long to diagnose in full; replace it with the exact canonical block below.",
        path: buildHandoffHeading,
      },
    ];
  }
  const match = /^\n```json\n(?<json>[\s\S]*?)\n```(?<trailing>[\s\S]*)$/u.exec(handoff);
  if (match?.groups?.json === undefined) {
    return [
      {
        message:
          "Use one blank line after the heading, then exactly one lowercase json fenced block; remove other text and trailing content.",
        path: buildHandoffHeading,
      },
    ];
  }
  if ((match.groups.trailing ?? "") !== "") {
    return [
      {
        message:
          "Remove all content after the closing JSON fence; the handoff must be the final document content.",
        path: buildHandoffHeading,
      },
    ];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(match.groups.json);
  } catch {
    return [
      {
        message: "The fenced handoff body must be valid JSON.",
        path: buildHandoffHeading,
      },
    ];
  }
  const result = buildReadyHandoffSchema.safeParse(parsed);
  if (!result.success) {
    return result.error.issues.map((issue) => ({
      message: issue.message,
      path: [buildHandoffHeading, ...issue.path].join("."),
    }));
  }
  return [
    {
      message: "Match the canonical spacing and bytes shown below exactly.",
      path: buildHandoffHeading,
    },
  ];
};

const createRepairDiagnostic = (input: {
  firstHandoffMismatchIndex?: number;
  handoff: string;
  handoffDiagnosticTruncated: boolean;
  hasCarriageReturn: boolean;
  inHandoff: boolean;
  missingOrRepeated: string[];
}): string => {
  const issues: RepairIssue[] = [];
  if (input.hasCarriageReturn) {
    issues.push({
      message:
        "Use LF line endings throughout; carriage returns are not part of the accepted v2 bytes.",
      path: "AppSpec",
    });
  }
  for (const heading of input.missingOrRepeated) {
    issues.push({
      message: `Include exactly one "## ${heading}" heading.`,
      path: heading,
    });
  }
  if (input.inHandoff) {
    issues.push(...diagnoseHandoff(input.handoff, input.handoffDiagnosticTruncated));
    if (input.firstHandoffMismatchIndex !== undefined) {
      issues.push({
        message: `The first mismatch is at handoff character ${input.firstHandoffMismatchIndex}; the complete handoff must match the canonical block below.`,
        path: buildHandoffHeading,
      });
    }
  } else {
    issues.push({
      message: "The document must end with exactly one ## Build handoff section.",
      path: buildHandoffHeading,
    });
  }
  return JSON.stringify({
    buildHandoffExample: BUILD_READY_HANDOFF_EXAMPLE,
    canonicalBuildHandoff,
    code: "app_spec_invalid",
    instruction:
      "Repair and replace the complete Markdown artifact, then retry accept_app_spec without asking the user.",
    issues,
    requiredHeadings: REQUIRED_APP_SPEC_HEADINGS.map((heading) => `## ${heading}`),
  });
};

/** A v2 AppSpec is accepted only in its canonical byte form. This keeps the
 * accepted digest identical to the verified artifact digest without copying
 * the complete document into workflow state. Legacy v1 normalization remains
 * available for historical snapshots and noncanonical drafts. */
// oxlint-disable sonarjs/cognitive-complexity -- The streaming state machine checks headings, handoff, and walkthrough in one pass.
export const inspectCanonicalAppSpec = async (input: {
  artifact: PrototypeArtifactV2;
  readChunk: ReadPrototypeChunk;
}): Promise<{ digest: string; walkthrough: string }> => {
  await verifyPrototypeArtifactManifest(input);
  const counts = new Map<string, number>();
  const hash = createHash("sha256");
  const walkthroughLines: string[] = [];
  let currentLine = "";
  let inWalkthrough = false;
  let fence: string | null = null;
  let inHandoff = false;
  let handoffIndex = 0;
  let handoffMatches = true;
  let handoffDiagnostic = "";
  let handoffDiagnosticTruncated = false;
  let firstHandoffMismatchIndex: number | undefined;
  let hasCarriageReturn = false;
  const consumeLine = () => {
    const marker = /^\s*(?<marker>```+|~~~+)/u.exec(currentLine)?.groups?.marker;
    if (marker !== undefined) {
      if (fence === null) {
        fence = marker.charAt(0);
      } else if (marker.startsWith(fence)) {
        fence = null;
      }
    }
    const heading = currentLine.startsWith("## ") ? currentLine.slice(3) : "";
    if (headingNames.has(heading)) {
      counts.set(heading, (counts.get(heading) ?? 0) + 1);
    }
    if (heading === buildHandoffHeading) {
      inHandoff = true;
    }
    if (fence === null && currentLine.startsWith("## ")) {
      if (inWalkthrough) {
        inWalkthrough = false;
      }
      if (heading === "Acceptance walkthrough") {
        inWalkthrough = true;
      }
    } else if (inWalkthrough) {
      walkthroughLines.push(currentLine);
    }
    currentLine = "";
  };
  for (let index = 0; index < input.artifact.chunkCount; index += 1) {
    // oxlint-disable-next-line eslint/no-await-in-loop, react-doctor/async-await-in-loop -- Manifest order is part of the accepted digest.
    const chunk = await input.readChunk(index);
    if (chunk === undefined) {
      throw new Error(`The AppSpec is missing chunk ${index}.`);
    }
    hash.update(chunk, "utf-8");
    for (const character of chunk) {
      if (character === "\r") {
        hasCarriageReturn = true;
      }
      if (inHandoff) {
        if (canonicalHandoff[handoffIndex] !== character) {
          handoffMatches = false;
          firstHandoffMismatchIndex ??= handoffIndex;
        }
        if (handoffDiagnostic.length < maxHandoffDiagnosticLength) {
          handoffDiagnostic += character;
        } else {
          handoffDiagnosticTruncated = true;
        }
        handoffIndex += 1;
      } else if (character === "\n") {
        consumeLine();
      } else if (currentLine.length <= maxHeadingLength || inWalkthrough) {
        currentLine += character;
      }
    }
  }
  if (!inHandoff && currentLine !== "") {
    consumeLine();
  }
  const missingOrRepeated = REQUIRED_APP_SPEC_HEADINGS.filter(
    (heading) => counts.get(heading) !== 1,
  );
  const invalidHandoff = !inHandoff || !handoffMatches || handoffIndex !== canonicalHandoff.length;
  if (hasCarriageReturn || missingOrRepeated.length > 0 || invalidHandoff) {
    throw new Error(
      createRepairDiagnostic({
        firstHandoffMismatchIndex,
        handoff: handoffDiagnostic,
        handoffDiagnosticTruncated,
        hasCarriageReturn,
        inHandoff,
        missingOrRepeated,
      }),
    );
  }
  const digest = hash.digest("hex");
  if (digest !== input.artifact.digest) {
    throw new Error("The streamed AppSpec digest changed during acceptance.");
  }
  return { digest, walkthrough: walkthroughLines.join("\n").trim() };
};

// oxlint-enable sonarjs/cognitive-complexity

/** A downstream consumer gets verified bytes on demand; accepted v2 workflow
 * state never retains an additional whole-content copy. */
export const readAcceptedAppSpecContent = async (input: {
  accepted: AcceptedAppSpec;
  artifact: PrototypeArtifactV2;
  readChunk: ReadPrototypeChunk;
}): Promise<string> => {
  const { accepted, artifact } = input;
  if (
    accepted.artifactPath !== artifact.path ||
    accepted.artifactRevision !== artifact.revision ||
    accepted.digest !== artifact.digest
  ) {
    throw new Error("The accepted AppSpec reference does not match the recorded artifact.");
  }
  await verifyPrototypeArtifactManifest({
    artifact,
    readChunk: input.readChunk,
  });
  const chunks: string[] = [];
  for (let index = 0; index < artifact.chunkCount; index += 1) {
    // oxlint-disable-next-line eslint/no-await-in-loop, react-doctor/async-await-in-loop -- Exact ordered readback is required.
    const chunk = await input.readChunk(index);
    if (chunk === undefined) {
      throw new Error(`The accepted AppSpec is missing chunk ${index}.`);
    }
    chunks.push(chunk);
  }
  return chunks.join("");
};
