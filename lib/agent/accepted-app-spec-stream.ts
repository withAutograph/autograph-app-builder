import { createHash } from "node:crypto";

import type { AcceptedAppSpec, PrototypeArtifactV2 } from "./workflow-state";
import type { ReadPrototypeChunk } from "./prototype-artifact-stream";
import { verifyPrototypeArtifactManifest } from "./prototype-artifact-stream";
import { appSpecRepairDiagnostic, createBuildReadyAppSpecScanner } from "./app-spec-validation";

/** Verify exact artifact bytes and explicit intent without prescribing prose formatting. */
export const inspectCanonicalAppSpec = async (input: {
  artifact: PrototypeArtifactV2;
  readChunk: ReadPrototypeChunk;
}): Promise<{ digest: string; walkthrough: string }> => {
  await verifyPrototypeArtifactManifest(input);
  const scanner = createBuildReadyAppSpecScanner();
  const hash = createHash("sha256");
  const walkthroughLines: string[] = [];
  let currentLine = "";
  let previousCarriageReturn = false;
  let inWalkthrough = false;
  let fence: string | null = null;
  const consumeLine = () => {
    scanner.consumeLine(currentLine);
    const line = currentLine.replace(/\r$/u, "");
    const marker = /^\s*(?<marker>```+|~~~+)/u.exec(line)?.groups?.marker;
    if (marker !== undefined) {
      if (fence === null) {
        fence = marker.charAt(0);
      } else if (marker.startsWith(fence)) {
        fence = null;
      }
    }
    if (fence === null && /^##\s+/u.test(line)) {
      inWalkthrough = /^##\s+Acceptance walkthrough\s*$/iu.test(line);
    } else if (inWalkthrough) {
      walkthroughLines.push(line);
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
        consumeLine();
        previousCarriageReturn = true;
      } else if (character === "\n") {
        if (!previousCarriageReturn) {
          consumeLine();
        }
        previousCarriageReturn = false;
      } else {
        previousCarriageReturn = false;
        currentLine += character;
      }
    }
  }
  if (currentLine !== "") {
    consumeLine();
  }
  const validation = scanner.result();
  if (!validation.valid) {
    throw new Error(appSpecRepairDiagnostic(validation));
  }
  const digest = hash.digest("hex");
  if (digest !== input.artifact.digest) {
    throw new Error("The streamed AppSpec digest changed during acceptance.");
  }
  return { digest, walkthrough: walkthroughLines.join("\n").trim() };
};

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
