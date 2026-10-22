import type { HostedOperatorCallbackExecution } from "../provisioning/hosted-operator-callback-owner";
import { createHash } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { SandboxSession } from "eve/sandbox";
import { runSequentially } from "../async-sequential";
import {
  canonicalSchemaPredecessorState,
  compiledSchemaPredecessorState,
  rememberCompiledSchemaPredecessors,
} from "./schema-predecessor-state";
import type { CompiledOperatorReleaseSelection } from "../provisioning/hosted-operator-artifact-selection";
import type { CompiledSchemaPredecessorInput } from "./schema-predecessor-state";
import { safeSourcePath } from "../repository/source-path";
import {
  compiledArtifactSandboxRelativePath,
  readExactCompiledOperatorReleaseForSession,
} from "./compiled-operator-artifacts";
import { restoreCanonicalCheckedRelease, SchemaPredecessorError } from "./schema-predecessor";
import { appBuilderWorkflowState } from "./workflow-state";

interface ValidationInput {
  adapterSessionId: string;
  appId: string;
  callId: string;
  callbackExecution?: HostedOperatorCallbackExecution;
  root: string;
  sessionAuth: unknown;
  sandbox: Pick<SandboxSession, "readBinaryFile" | "writeBinaryFile">;
  signal?: AbortSignal;
}

export interface CompiledSchemaValidationDependencies {
  getSavedInputs: () => Record<string, CompiledSchemaPredecessorInput>;
  getCanonicalRefs: () => readonly CompiledOperatorReleaseSelection[];
  getAppSpec: () => { appId: string; digest: string } | undefined;
  readOwnedRelease: typeof readExactCompiledOperatorReleaseForSession;
  rememberInputs: typeof rememberCompiledSchemaPredecessors;
}
const validationDependencies: CompiledSchemaValidationDependencies = {
  getAppSpec: () => {
    const state = appBuilderWorkflowState.get();
    // oxlint-disable-next-line unicorn/no-useless-undefined -- Empty workflows have no approved app.
    return "appSpec" in state ? state.appSpec : undefined;
  },
  getCanonicalRefs: () => canonicalSchemaPredecessorState.get(),
  getSavedInputs: () => compiledSchemaPredecessorState.get(),
  readOwnedRelease: async (input) => await readExactCompiledOperatorReleaseForSession(input),
  rememberInputs: rememberCompiledSchemaPredecessors,
};
const retainedLookup = "retained-lookup";
const unavailable = "canonical_schema_predecessor_unavailable";

const releaseSchema = z.looseObject({
  app_id: z.string(),
  customer_id: z.string(),
  version: z.string(),
});
const transitionContract = z.looseObject({
  app_id: z.string(),
  customer_id: z.string(),
  predecessors: z.array(z.looseObject({ schema: releaseSchema, version: z.string() })),
  version: z.string(),
});
const appArtifact = z.looseObject({ schema: releaseSchema });
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Older successful captures can prove a self predecessor because Arrusted excludes the current version from prior checked releases. */
const recoverCapturedSelfPredecessor = async (
  input: ValidationInput,
  appSpecDigest: string,
  dependencies: CompiledSchemaValidationDependencies,
): Promise<CompiledSchemaPredecessorInput | null> => {
  const candidates = dependencies
    .getCanonicalRefs()
    .filter((selection) => selection.appId === input.appId)
    .toReversed();
  let resolved = false;
  let recovered: CompiledSchemaPredecessorInput | null = null;
  await runSequentially(candidates, async (candidate) => {
    if (resolved) {
      return;
    }
    const releasePath = `apps/${input.appId}/schema/release/${candidate.releaseId}`;
    if (!safeSourcePath(releasePath) || path.posix.normalize(releasePath) !== releasePath) {
      return;
    }
    const directory = `${compiledArtifactSandboxRelativePath(input.root)}/${releasePath}`;
    const [artifactBytes, manifestBytes] = await Promise.all([
      input.sandbox.readBinaryFile({
        abortSignal: input.signal,
        path: `${directory}/app-artifact.json`,
      }),
      input.sandbox.readBinaryFile({
        abortSignal: input.signal,
        path: `${directory}/release-manifest.json`,
      }),
    ]);
    if (
      artifactBytes === null ||
      manifestBytes === null ||
      sha256(artifactBytes) !== candidate.schemaSha256
    ) {
      return;
    }
    let captured;
    try {
      captured = await dependencies.readOwnedRelease({
        ...input,
        appSpecDigest,
        lookup: {
          manifestSha256: sha256(manifestBytes),
          releaseId: candidate.releaseId,
          schemaSha256: candidate.schemaSha256,
        },
      });
    } catch {
      input.signal?.throwIfAborted();
      throw new SchemaPredecessorError(unavailable, {
        reason: "lookup-failed",
        stage: retainedLookup,
      });
    }
    if (captured === undefined) {
      return;
    }
    resolved = true;
    const contract = transitionContract.safeParse(
      JSON.parse(captured.files["transition-contract.json"].toString("utf-8")),
    );
    const artifact = appArtifact.safeParse(
      JSON.parse(captured.files["app-artifact.json"].toString("utf-8")),
    );
    if (!contract.success || !artifact.success) {
      return;
    }
    const target = captured.selection;
    const sameApp =
      contract.data.app_id === input.appId && artifact.data.schema.app_id === input.appId;
    const sameVersion =
      contract.data.version === target.releaseId &&
      artifact.data.schema.version === target.releaseId;
    const sameTarget =
      sameApp && sameVersion && contract.data.customer_id === artifact.data.schema.customer_id;
    const self =
      sameTarget &&
      contract.data.predecessors.some(
        (prior) =>
          prior.version === target.releaseId &&
          isDeepStrictEqual(prior.schema, artifact.data.schema),
      );
    if (!self) {
      return;
    }
    dependencies.rememberInputs(input.appId, [target], target);
    recovered = { compiled: target, predecessors: [target] };
  });
  return recovered;
};

/** Reuse the original compilation input even after runtime preparation installs the new release. */
export const prepareCompiledSchemaPredecessorsForValidationForSession = async (
  input: ValidationInput,
  dependencies: CompiledSchemaValidationDependencies = validationDependencies,
): Promise<{ environment: Record<string, string> }> => {
  let saved: CompiledSchemaPredecessorInput | undefined =
    dependencies.getSavedInputs()[input.appId];
  if (saved !== undefined && saved.predecessors.length === 0) {
    return { environment: {} };
  }
  if (
    saved === undefined &&
    !dependencies.getCanonicalRefs().some((selection) => selection.appId === input.appId)
  ) {
    return { environment: {} };
  }
  const appSpec = dependencies.getAppSpec();
  if (appSpec === undefined || appSpec.appId !== input.appId) {
    throw new SchemaPredecessorError(unavailable, {
      reason: "app-mismatch",
      stage: "receipt",
    });
  }
  saved ??=
    (await recoverCapturedSelfPredecessor(input, appSpec.digest, dependencies)) ?? undefined;
  if (saved === undefined) {
    return { environment: {} };
  }
  const compiledTarget = saved.compiled;
  const paths: string[] = [];
  await runSequentially(saved.predecessors, async (selection) => {
    let predecessor;
    try {
      predecessor = await dependencies.readOwnedRelease({
        ...input,
        appSpecDigest: appSpec.digest,
        lookup: { artifactRef: selection.artifactRef },
      });
    } catch {
      input.signal?.throwIfAborted();
      throw new SchemaPredecessorError(unavailable, {
        reason: "lookup-failed",
        stage: retainedLookup,
      });
    }
    if (predecessor === undefined) {
      throw new SchemaPredecessorError(unavailable, {
        reason: "missing-history",
        stage: retainedLookup,
      });
    }
    if (
      predecessor.selection.appId !== input.appId ||
      predecessor.selection.releaseId !== selection.releaseId ||
      predecessor.selection.schemaSha256 !== selection.schemaSha256 ||
      createHash("sha256").update(predecessor.files["app-artifact.json"]).digest("hex") !==
        selection.schemaSha256
    ) {
      throw new SchemaPredecessorError(unavailable, {
        reason: "artifact-mismatch",
        stage: "match",
      });
    }
    const file = path.posix.join(
      ".app-builder",
      "schema-predecessors",
      createHash("sha256").update(input.adapterSessionId).digest("hex"),
      input.appId,
      selection.schemaSha256,
      "app-artifact.json",
    );
    // Existing live files are ordinary source input. Restore only actual missing files.
    const writeMissing: SandboxSession["writeBinaryFile"] = async (request) => {
      const existing = await input.sandbox.readBinaryFile({
        abortSignal: input.signal,
        path: request.path,
      });
      if (existing === null) {
        await input.sandbox.writeBinaryFile(request);
      }
    };
    try {
      await writeMissing({
        abortSignal: input.signal,
        content: predecessor.files["app-artifact.json"],
        path: file,
      });
      if (compiledTarget?.releaseId !== selection.releaseId) {
        await restoreCanonicalCheckedRelease({
          appId: input.appId,
          predecessor,
          root: input.root,
          sandbox: { writeBinaryFile: writeMissing },
          signal: input.signal,
        });
      }
    } catch (error) {
      input.signal?.throwIfAborted();
      if (error instanceof SchemaPredecessorError) {
        throw error;
      }
      throw new SchemaPredecessorError(unavailable, {
        reason: "write-failed",
        stage: "restore",
      });
    }
    paths.push(path.posix.join("/workspace", file));
  });
  return { environment: { APP_SCHEMA_TRANSITION_PREDECESSOR_FILES: JSON.stringify(paths) } };
};
