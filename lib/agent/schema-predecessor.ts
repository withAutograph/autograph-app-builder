import { createHash } from "node:crypto";
import path from "node:path";
import type { SandboxSession } from "eve/sandbox";
import { z } from "zod";
import { runSequentially } from "../async-sequential";
import { localRuntimeEnvironmentPath } from "../repository/runtime-environment";
import { safeSourcePath } from "../repository/source-path";
import {
  canonicalSchemaPredecessorState,
  rememberCanonicalSchemaRelease,
} from "./schema-predecessor-state";
import {
  compiledArtifactSandboxRelativePath,
  readExactCompiledOperatorReleaseForSession,
} from "./compiled-operator-artifacts";
import type { CompiledOperatorArtifactSessionInput } from "./compiled-operator-artifacts";
import type { CompiledOperatorReleaseSelection } from "../provisioning/hosted-operator-artifact-selection";
import type { GeneratedAppReleaseFiles } from "../provisioning/hosted-operator-sandbox-launcher";

const appId = z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u);
const hash = z
  .string()
  .regex(/^(?:sha256:)?[a-f0-9]{64}$/u)
  .transform((value) => value.replace(/^sha256:/u, ""));
const installedReceipt = z.strictObject({
  appId,
  environment: z.literal("local"),
  installations: z.array(
    z.strictObject({
      baseArtifactHash: hash,
      effectiveArtifactHash: hash,
      releaseId: z.string().min(1),
      schemaRevisionId: z.union([z.number().int().positive(), z.string().min(1)]),
      tenant: z.string().min(1),
    }),
  ),
  runtimeId: z.string().min(1),
  state: z.literal("installed"),
  version: z.literal(1),
});
const installedStatus = z.discriminatedUnion("state", [
  installedReceipt,
  z.strictObject({
    appId,
    environment: z.literal("local"),
    runtimeId: z.string().min(1),
    state: z.literal("not-prepared"),
    version: z.literal(1),
  }),
]);
export class SchemaPredecessorError extends Error {
  readonly code: "canonical_schema_predecessor_unavailable" | "schema_release_identity_reused";
  constructor(code: SchemaPredecessorError["code"]) {
    super(
      code === "schema_release_identity_reused"
        ? "The installed release ID already belongs to different schema bytes. Author a new schema release ID in the accepted app source, then compile and validate again. The exact installed checked release has been restored."
        : "The exact installed schema predecessor is unavailable under this app's current owner and saved session. Restore its previously recorded immutable compiled release or owned source history; do not reconstruct its bytes or replace its database.",
    );
    this.name = "SchemaPredecessorError";
    this.code = code;
  }
}
export interface CanonicalSchemaPredecessor {
  files: GeneratedAppReleaseFiles;
  selection: CompiledOperatorReleaseSelection;
}
export interface PreparedSchemaPredecessors {
  environment: Record<string, string>;
  predecessors: CanonicalSchemaPredecessor[];
}
type SchemaSandbox = Pick<SandboxSession, "run" | "writeBinaryFile">;

/** Restore only a retained checked release. Authored CUE and the generated pointer remain normal compiler inputs. */
export const restoreCanonicalCheckedRelease = async (input: {
  appId: string;
  predecessor: CanonicalSchemaPredecessor;
  root: string;
  sandbox: Pick<SandboxSession, "writeBinaryFile">;
  signal?: AbortSignal;
}) => {
  const relativeRoot = compiledArtifactSandboxRelativePath(input.root);
  const prefix = `apps/${appId.parse(input.appId)}/schema/release/`;
  const releaseRoot = prefix + input.predecessor.selection.releaseId;
  if (
    !safeSourcePath(releaseRoot) ||
    path.posix.normalize(releaseRoot) !== releaseRoot ||
    !releaseRoot.startsWith(prefix)
  ) {
    throw new SchemaPredecessorError("canonical_schema_predecessor_unavailable");
  }
  await runSequentially(Object.entries(input.predecessor.files), async ([member, content]) => {
    await input.sandbox.writeBinaryFile({
      abortSignal: input.signal,
      content,
      path: `${relativeRoot}/${releaseRoot}/${member}`,
    });
  });
};

/** A real local installation identifies its exact canonical compiler input; labels alone cannot select history. */
export const prepareCanonicalSchemaPredecessorsForSession = async (
  input: CompiledOperatorArtifactSessionInput & { sandbox: SchemaSandbox },
): Promise<PreparedSchemaPredecessors> => {
  const selectedApp = appId.parse(input.appId);
  const environmentFile = localRuntimeEnvironmentPath(input.root, selectedApp);
  const directory = path.posix.dirname(environmentFile);
  const observed = await input.sandbox.run({
    abortSignal: input.signal,
    command: `mise run app:runtime installed ${selectedApp} local`,
    env: { APP_RUNTIME_STATE_DIR: directory },
    workingDirectory: input.root,
  });
  if (observed.exitCode !== 0) {
    throw new SchemaPredecessorError("canonical_schema_predecessor_unavailable");
  }
  const receipt = installedStatus.parse(JSON.parse(observed.stdout));
  if (receipt.appId !== selectedApp) {
    throw new SchemaPredecessorError("canonical_schema_predecessor_unavailable");
  }
  if (receipt.state === "not-prepared") {
    return { environment: {}, predecessors: [] };
  }
  const predecessors: CanonicalSchemaPredecessor[] = [];
  const paths: string[] = [];
  await runSequentially(receipt.installations, async (installation) => {
    if (
      predecessors.some(
        ({ selection }) =>
          selection.releaseId === installation.releaseId &&
          selection.schemaSha256 === installation.baseArtifactHash,
      )
    ) {
      return;
    }
    const retained = canonicalSchemaPredecessorState
      .get()
      .find(
        (selection) =>
          selection.appId === selectedApp &&
          selection.releaseId === installation.releaseId &&
          selection.schemaSha256 === installation.baseArtifactHash,
      );
    const lookup =
      retained === undefined
        ? { releaseId: installation.releaseId, schemaSha256: installation.baseArtifactHash }
        : { artifactRef: retained.artifactRef };
    const predecessor = await readExactCompiledOperatorReleaseForSession({ ...input, lookup });
    if (
      predecessor === undefined ||
      predecessor.selection.releaseId !== installation.releaseId ||
      predecessor.selection.schemaSha256 !== installation.baseArtifactHash ||
      createHash("sha256").update(predecessor.files["app-artifact.json"]).digest("hex") !==
        installation.baseArtifactHash
    ) {
      throw new SchemaPredecessorError("canonical_schema_predecessor_unavailable");
    }
    rememberCanonicalSchemaRelease(predecessor.selection);
    const file = path.posix.join(
      ".app-builder",
      "schema-predecessors",
      createHash("sha256").update(input.adapterSessionId).digest("hex"),
      selectedApp,
      installation.baseArtifactHash,
      "app-artifact.json",
    );
    await input.sandbox.writeBinaryFile({
      abortSignal: input.signal,
      content: predecessor.files["app-artifact.json"],
      path: file,
    });
    paths.push(path.posix.join("/workspace", file));
    await restoreCanonicalCheckedRelease({
      appId: selectedApp,
      predecessor,
      root: input.root,
      sandbox: input.sandbox,
      signal: input.signal,
    });
    predecessors.push(predecessor);
  });
  return {
    environment: { APP_SCHEMA_TRANSITION_PREDECESSOR_FILES: JSON.stringify(paths) },
    predecessors,
  };
};

/** Kernel release identities cannot be reused for a changed schema. Preserve the old checked bytes on this repair outcome. */
export const assertCompiledSchemaReleaseIdentity = async (input: {
  appId: string;
  compiled: Pick<CompiledOperatorReleaseSelection, "releaseId" | "schemaSha256">;
  prepared: PreparedSchemaPredecessors;
  root: string;
  sandbox: Pick<SandboxSession, "writeBinaryFile">;
  signal?: AbortSignal;
}) => {
  const predecessor = input.prepared.predecessors.find(
    ({ selection }) =>
      selection.releaseId === input.compiled.releaseId &&
      selection.schemaSha256 !== input.compiled.schemaSha256,
  );
  if (predecessor !== undefined) {
    await restoreCanonicalCheckedRelease({ ...input, predecessor });
    throw new SchemaPredecessorError("schema_release_identity_reused");
  }
};
