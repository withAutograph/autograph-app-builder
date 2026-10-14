import { createHash } from "node:crypto";
import path from "node:path";
import type { SandboxSession } from "eve/sandbox";
import { z } from "zod";
import { runSequentially } from "../async-sequential";
import { localRuntimeEnvironmentPath } from "../repository/runtime-environment";
import { safeSourcePath } from "../repository/source-path";
import { boundedCommandDiagnostic } from "./command-output";
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
/* oxlint-disable sonarjs/max-union-size -- Closed recovery stages and concrete reasons diagnose actual operations without untrusted payloads. */
export interface SchemaPredecessorRecovery {
  stage: "probe" | "receipt" | "retained-lookup" | "match" | "restore";
  reason:
    | "command-failed"
    | "execution-failed"
    | "invalid-receipt"
    | "app-mismatch"
    | "lookup-failed"
    | "missing-history"
    | "artifact-mismatch"
    | "invalid-release-path"
    | "write-failed";
  command?: string;
  exitCode?: number | null;
  diagnostic?: string;
  diagnosticPresent?: boolean;
  diagnosticLength?: number;
  diagnosticTruncated?: boolean;
  outputPresence?: { stdout: boolean; stderr: boolean };
}
/* oxlint-enable sonarjs/max-union-size */
const recoveryProblem = (recovery: SchemaPredecessorRecovery | undefined): string => {
  if (recovery === undefined || recovery.reason === "missing-history") {
    return "The exact installed schema predecessor is unavailable under this app's current owner and saved session. Restore its previously recorded immutable compiled release or owned source history; do not reconstruct its bytes or replace its database.";
  }
  const problems: Record<SchemaPredecessorRecovery["stage"], string> = {
    match:
      "The retained compiled release does not match the exact installed release identity and artifact hash. Restore the matching immutable release; do not guess its bytes or replace its database.",
    probe:
      "The installed-runtime observation command failed before schema compilation. Restore private runtime command execution, then retry this saved app; this failure does not establish missing artifact history.",
    receipt:
      "The installed-runtime observation returned an invalid or mismatched installation receipt before schema compilation. Restore a valid receipt for this app, then retry.",
    restore:
      "Restoring the exact retained schema predecessor into the private checkout failed. Restore its writable checkout and exact release path before compiling; do not replace its database.",
    "retained-lookup":
      "The retained compiled release lookup failed under the current owner and saved session. Restore private artifact access, then retry; this failure does not establish missing artifact history.",
  };
  return problems[recovery.stage];
};
const recoveryDiagnosticFields = (
  summary: ReturnType<typeof boundedCommandDiagnostic>,
): Pick<
  SchemaPredecessorRecovery,
  "diagnostic" | "diagnosticLength" | "diagnosticPresent" | "diagnosticTruncated"
> => {
  const fields: Pick<
    SchemaPredecessorRecovery,
    "diagnostic" | "diagnosticLength" | "diagnosticPresent" | "diagnosticTruncated"
  > = {
    diagnosticLength: summary.length,
    diagnosticPresent: summary.present,
    diagnosticTruncated: summary.truncated,
  };
  if (summary.present) {
    fields.diagnostic = summary.diagnostic;
  }
  return fields;
};
export class SchemaPredecessorError extends Error {
  readonly code: "canonical_schema_predecessor_unavailable" | "schema_release_identity_reused";
  readonly recovery?: SchemaPredecessorRecovery;
  constructor(code: SchemaPredecessorError["code"], recovery?: SchemaPredecessorRecovery) {
    super(
      code === "schema_release_identity_reused"
        ? "The installed release ID already belongs to different schema bytes. Author a new schema release ID in the accepted app source, then compile and validate again. The exact installed checked release has been restored."
        : recoveryProblem(recovery),
    );
    this.name = "SchemaPredecessorError";
    this.code = code;
    this.recovery = recovery;
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
    throw new SchemaPredecessorError("canonical_schema_predecessor_unavailable", {
      reason: "invalid-release-path",
      stage: "restore",
    });
  }
  try {
    await runSequentially(Object.entries(input.predecessor.files), async ([member, content]) => {
      await input.sandbox.writeBinaryFile({
        abortSignal: input.signal,
        content,
        path: `${relativeRoot}/${releaseRoot}/${member}`,
      });
    });
  } catch {
    input.signal?.throwIfAborted();
    throw new SchemaPredecessorError("canonical_schema_predecessor_unavailable", {
      reason: "write-failed",
      stage: "restore",
    });
  }
};

/** A real local installation identifies its exact canonical compiler input; labels alone cannot select history. */
export const prepareCanonicalSchemaPredecessorsForSession = async (
  input: CompiledOperatorArtifactSessionInput & { sandbox: SchemaSandbox },
): Promise<PreparedSchemaPredecessors> => {
  const selectedApp = appId.parse(input.appId);
  const environmentFile = localRuntimeEnvironmentPath(input.root, selectedApp);
  const directory = path.posix.dirname(environmentFile);
  // Resume only the recorded local cluster before reading its actual installed schema identity.
  const command = `mise run app:runtime resume-installed ${selectedApp} local`;
  let observed;
  try {
    observed = await input.sandbox.run({
      abortSignal: input.signal,
      command,
      env: { APP_RUNTIME_STATE_DIR: directory },
      workingDirectory: input.root,
    });
  } catch (error) {
    input.signal?.throwIfAborted();
    const summary = boundedCommandDiagnostic(
      error instanceof Error ? error.message : String(error),
    );
    throw new SchemaPredecessorError("canonical_schema_predecessor_unavailable", {
      command,
      ...recoveryDiagnosticFields(summary),
      exitCode: null,
      outputPresence: { stderr: false, stdout: false },
      reason: "execution-failed",
      stage: "probe",
    });
  }
  if (observed.exitCode !== 0) {
    const stdoutPresent = observed.stdout.length > 0;
    const stderrPresent = observed.stderr.length > 0;
    const stderr = boundedCommandDiagnostic(observed.stderr);
    let summary = stderr;
    if (!stderr.present) {
      if (stdoutPresent) {
        summary = boundedCommandDiagnostic(
          "Command produced stdout; suppressed because it may contain a receipt.",
        );
      } else if (stderrPresent) {
        summary = boundedCommandDiagnostic(
          "Command produced stderr, but its contents were redacted.",
        );
      }
    }
    throw new SchemaPredecessorError("canonical_schema_predecessor_unavailable", {
      command,
      ...recoveryDiagnosticFields(summary),
      exitCode: observed.exitCode,
      outputPresence: { stderr: stderrPresent, stdout: stdoutPresent },
      reason: "command-failed",
      stage: "probe",
    });
  }
  let receipt;
  try {
    receipt = installedStatus.parse(JSON.parse(observed.stdout));
  } catch {
    throw new SchemaPredecessorError("canonical_schema_predecessor_unavailable", {
      command,
      exitCode: 0,
      reason: "invalid-receipt",
      stage: "receipt",
    });
  }
  if (receipt.appId !== selectedApp) {
    throw new SchemaPredecessorError("canonical_schema_predecessor_unavailable", {
      command,
      exitCode: 0,
      reason: "app-mismatch",
      stage: "receipt",
    });
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
    let predecessor;
    try {
      predecessor = await readExactCompiledOperatorReleaseForSession({ ...input, lookup });
    } catch {
      input.signal?.throwIfAborted();
      throw new SchemaPredecessorError("canonical_schema_predecessor_unavailable", {
        reason: "lookup-failed",
        stage: "retained-lookup",
      });
    }
    if (predecessor === undefined) {
      throw new SchemaPredecessorError("canonical_schema_predecessor_unavailable", {
        reason: "missing-history",
        stage: "retained-lookup",
      });
    }
    if (
      predecessor.selection.releaseId !== installation.releaseId ||
      predecessor.selection.schemaSha256 !== installation.baseArtifactHash ||
      createHash("sha256").update(predecessor.files["app-artifact.json"]).digest("hex") !==
        installation.baseArtifactHash
    ) {
      throw new SchemaPredecessorError("canonical_schema_predecessor_unavailable", {
        reason: "artifact-mismatch",
        stage: "match",
      });
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
    try {
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
    } catch (error) {
      input.signal?.throwIfAborted();
      if (error instanceof SchemaPredecessorError) {
        throw error;
      }
      throw new SchemaPredecessorError("canonical_schema_predecessor_unavailable", {
        reason: "write-failed",
        stage: "restore",
      });
    }
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
