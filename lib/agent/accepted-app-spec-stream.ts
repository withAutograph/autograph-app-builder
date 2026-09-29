import { createHash } from "node:crypto";

import type { AcceptedAppSpec, PrototypeArtifactV2 } from "./workflow-state";
import type { ReadPrototypeChunk } from "./prototype-artifact-stream";
import { verifyPrototypeArtifactManifest } from "./prototype-artifact-stream";
import { REQUIRED_APP_SPEC_HEADINGS } from "./app-spec-validation";

const canonicalHandoff = '\n```json\n{\n  "status": "build-ready"\n}\n```';
const headingNames = new Set<string>(REQUIRED_APP_SPEC_HEADINGS);
const maxHeadingLength =
  Math.max(...REQUIRED_APP_SPEC_HEADINGS.map((heading) => heading.length)) + 3;

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
    if (heading === "Build handoff") {
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
      `The streamed AppSpec must use the exact canonical Build handoff and each required heading once. Repair and rerecord the artifact before acceptance. Invalid headings: ${missingOrRepeated.join(", ") || "none"}.`,
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
  await verifyPrototypeArtifactManifest({ artifact, readChunk: input.readChunk });
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
