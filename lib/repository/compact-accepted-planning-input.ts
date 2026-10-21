import { createHash } from "node:crypto";
import path from "node:path";
import type { SandboxSession } from "eve/sandbox";

import { planningOverlayRoot } from "./dependency-cache";
import { materializePlanningOverlay } from "./target-planning";
import { ensureSandboxDirectories } from "./sandbox-filesystem";
import { safeSourcePath } from "./source-path";

const hash = (content: string | Uint8Array): string =>
  createHash("sha256").update(content).digest("hex");

/** Recreate only this accepted revision's derived input, never a working checkout. */
export const compactAcceptedPlanningInput = async (input: {
  sandbox: SandboxSession;
  appId: string;
  artifactRevision: string;
  appSpecDigest: string;
  proposalAppSpec: { path: string; sha256: string };
  retainedRoots: readonly string[];
  readAcceptedContent: () => Promise<string>;
}): Promise<{ status: "compacted" | "retained" }> => {
  const root = planningOverlayRoot(input.artifactRevision);
  const absoluteRoot = path.posix.resolve(input.sandbox.resolvePath(root));
  const containsWorkingRoot = input.retainedRoots.some((retained) => {
    const absolute = path.posix.resolve(input.sandbox.resolvePath(retained));
    return absolute === absoluteRoot || absolute.startsWith(`${absoluteRoot}/`);
  });
  if (
    containsWorkingRoot ||
    !safeSourcePath(input.proposalAppSpec.path) ||
    input.proposalAppSpec.sha256 !== input.appSpecDigest
  ) {
    return { status: "retained" };
  }

  // Reopen the complete independently retained content before removing scratch.
  // A lazy verified stream alone would not prove availability before removal.
  const content = await input.readAcceptedContent();
  if (hash(content) !== input.appSpecDigest) {
    throw new Error("The accepted AppSpec could not be verified; its planning input was retained.");
  }
  await materializePlanningOverlay({
    appId: input.appId,
    appSpecContent: content,
    appSpecDigest: input.appSpecDigest,
    artifactRevision: input.artifactRevision,
    sandbox: input.sandbox,
  });
  const canonicalPath = `prototype/${input.appId}/app-spec.md`;
  if (input.proposalAppSpec.path !== canonicalPath) {
    const transport = `${root}/${input.proposalAppSpec.path}`;
    await ensureSandboxDirectories(input.sandbox, [transport.slice(0, transport.lastIndexOf("/"))]);
    await input.sandbox.writeTextFile({ content, path: transport });
  }
  const paths = [...new Set([canonicalPath, input.proposalAppSpec.path])];
  await Promise.all(
    paths.map(async (relative) => {
      const restored = await input.sandbox.readBinaryFile({ path: `${root}/${relative}` });
      if (restored === null || hash(restored) !== input.appSpecDigest) {
        throw new Error(
          "The accepted planning input was not restored exactly. Retry this same draft preparation.",
        );
      }
    }),
  );
  return { status: "compacted" };
};
