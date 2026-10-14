/* oxlint-disable eslint/require-await, anti-slop/no-module-mocking, typescript/no-unsafe-type-assertion, anti-slop/require-safety-comment-for-type-assertion -- Owned metadata and immutable-byte ports exercise normal orchestration without a real app or provider. */
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SandboxSession } from "eve/sandbox";
import { z } from "zod";
import {
  assertCompiledSchemaReleaseIdentity,
  prepareCanonicalSchemaPredecessorsForSession,
  SchemaPredecessorError,
} from "./schema-predecessor";
import { GENERATED_RELEASE_MEMBERS } from "../provisioning/hosted-operator-sandbox-launcher";
import type { GeneratedAppReleaseFiles } from "../provisioning/hosted-operator-sandbox-launcher";
import type { CompiledOperatorReleaseSelection } from "../provisioning/hosted-operator-artifact-selection";

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  retained: [] as CompiledOperatorReleaseSelection[],
}));
vi.mock("./schema-predecessor-state", () => ({
  canonicalSchemaPredecessorState: { get: () => mocks.retained },
  rememberCanonicalSchemaRelease: vi.fn(),
}));
vi.mock("./compiled-operator-artifacts", () => ({
  compiledArtifactSandboxRelativePath: (root: string) => root.slice("/workspace/".length),
  readExactCompiledOperatorReleaseForSession: mocks.read,
}));
const artifact = Buffer.from(
  JSON.stringify({ schema: { app_id: "spend-review", version: "original-v2" } }),
);
const schemaHash = createHash("sha256").update(artifact).digest("hex");
const selection: CompiledOperatorReleaseSelection = {
  appId: "spend-review",
  appSpecDigest: "a".repeat(64),
  artifactRef: `_protected-operator/artifacts/generated-release/spend-review/${"b".repeat(64)}`,
  manifestSha256: "c".repeat(64),
  releaseId: "original-v2",
  schemaSha256: schemaHash,
  version: 1,
};
// Every fixture byte is evaluator-owned synthetic data, never candidate output.
const files = Object.fromEntries(
  GENERATED_RELEASE_MEMBERS.map((member) => [
    member,
    member === "app-artifact.json" ? artifact : Buffer.from(`original:${member}`),
  ]),
) as GeneratedAppReleaseFiles;
const receipt = {
  appId: "spend-review",
  environment: "local",
  installations: ["tenant-a", "tenant-b"].map((tenant) => ({
    baseArtifactHash: schemaHash,
    effectiveArtifactHash: schemaHash,
    releaseId: "original-v2",
    schemaRevisionId: "42",
    tenant,
  })),
  runtimeId: "recorded-runtime",
  state: "installed",
  version: 1,
};
const fixture = () => {
  const sandbox = {
    run: vi.fn().mockResolvedValue({ exitCode: 0, stderr: "", stdout: JSON.stringify(receipt) }),
    writeBinaryFile: vi.fn<
      (input: Parameters<SandboxSession["writeBinaryFile"]>[0]) => Promise<void>
    >(async () => {}),
  };
  return {
    adapterSessionId: "saved-session",
    appId: "spend-review",
    appSpecDigest: "a".repeat(64),
    callId: "compile",
    root: "/workspace/repository",
    sandbox,
    sessionAuth: {},
  };
};
describe("canonical schema predecessor recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.retained = [];
    mocks.read.mockResolvedValue({ files, selection });
  });
  it("binds actual installed identity and restores exact immutable bytes outside mutable source", async () => {
    const input = fixture();
    const prepared = await prepareCanonicalSchemaPredecessorsForSession(input);
    expect(mocks.read).toHaveBeenCalledWith(
      expect.objectContaining({ lookup: { releaseId: "original-v2", schemaSha256: schemaHash } }),
    );
    expect(input.sandbox.run).toHaveBeenCalledWith(
      expect.objectContaining({ command: "mise run app:runtime installed spend-review local" }),
    );
    const external = z
      .array(z.string())
      .parse(JSON.parse(prepared.environment.APP_SCHEMA_TRANSITION_PREDECESSOR_FILES ?? "[]"));
    expect(external).toHaveLength(1);
    expect(external[0]).toMatch(/^\/workspace\/\.app-builder\/schema-predecessors\//u);
    expect(external[0]).not.toContain("/repository/");
    expect(input.sandbox.writeBinaryFile).toHaveBeenCalledWith(
      expect.objectContaining({
        content: artifact,
        path: "repository/apps/spend-review/schema/release/original-v2/app-artifact.json",
      }),
    );
    expect(input.sandbox.writeBinaryFile).toHaveBeenCalledTimes(
      GENERATED_RELEASE_MEMBERS.length + 1,
    );
  });
  it("uses a previously retained owned reference only when actual ID and hash match", async () => {
    mocks.retained = [selection];
    await prepareCanonicalSchemaPredecessorsForSession(fixture());
    expect(mocks.read).toHaveBeenCalledWith(
      expect.objectContaining({ lookup: { artifactRef: selection.artifactRef } }),
    );
  });
  it("does not guess old bytes when exact captured history is missing", async () => {
    const input = fixture();
    mocks.read.mockImplementation(async () => {});
    await expect(prepareCanonicalSchemaPredecessorsForSession(input)).rejects.toMatchObject({
      code: "canonical_schema_predecessor_unavailable",
      recovery: { reason: "missing-history", stage: "retained-lookup" },
    });
    expect(input.sandbox.writeBinaryFile).not.toHaveBeenCalled();
  });
  it("rejects captured bytes that do not match the actual installed artifact hash", async () => {
    const input = fixture();
    mocks.read.mockResolvedValue({
      files: { ...files, "app-artifact.json": Buffer.from("mutated checkout schema") },
      selection,
    });
    await expect(prepareCanonicalSchemaPredecessorsForSession(input)).rejects.toMatchObject({
      recovery: { reason: "artifact-mismatch", stage: "match" },
    });
    expect(input.sandbox.writeBinaryFile).not.toHaveBeenCalled();
  });
  it("accepts only the owned CLI absence receipt without creating a runtime or reading private state", async () => {
    const input = fixture();
    input.sandbox.run.mockResolvedValue({
      exitCode: 0,
      stderr: "",
      stdout: JSON.stringify({
        appId: "spend-review",
        environment: "local",
        runtimeId: "recorded-runtime",
        state: "not-prepared",
        version: 1,
      }),
    });
    await expect(prepareCanonicalSchemaPredecessorsForSession(input)).resolves.toEqual({
      environment: {},
      predecessors: [],
    });
    expect(input.sandbox.run).toHaveBeenCalledOnce();
    expect(mocks.read).not.toHaveBeenCalled();
  });
  it("blocks unreadable installed identity without changing schema or source", async () => {
    const input = fixture();
    input.sandbox.run.mockResolvedValue({
      exitCode: 1,
      stderr: "private runtime unavailable",
      stdout: "",
    });
    await expect(prepareCanonicalSchemaPredecessorsForSession(input)).rejects.toMatchObject({
      code: "canonical_schema_predecessor_unavailable",
      recovery: {
        command: "mise run app:runtime installed spend-review local",
        exitCode: 1,
        reason: "command-failed",
        stage: "probe",
      },
    });
    expect(mocks.read).not.toHaveBeenCalled();
    expect(input.sandbox.writeBinaryFile).not.toHaveBeenCalled();
  });
  it("restores the activated release and asks the internal build agent for a new ID on changed shape", async () => {
    const input = fixture();
    const prepared = await prepareCanonicalSchemaPredecessorsForSession(input);
    input.sandbox.writeBinaryFile.mockClear();
    await expect(
      assertCompiledSchemaReleaseIdentity({
        ...input,
        compiled: { releaseId: "original-v2", schemaSha256: "d".repeat(64) },
        prepared,
      }),
    ).rejects.toMatchObject({ code: "schema_release_identity_reused" });
    expect(input.sandbox.writeBinaryFile).toHaveBeenCalledTimes(GENERATED_RELEASE_MEMBERS.length);
    expect(
      input.sandbox.writeBinaryFile.mock.calls.every(
        ([write]) => !write.path.endsWith(".cue") && !write.path.endsWith("schema/index.ts"),
      ),
    ).toBe(true);
  });
  it("accepts an unchanged active identity or a genuinely new release ID", async () => {
    const input = fixture();
    const prepared = await prepareCanonicalSchemaPredecessorsForSession(input);
    await assertCompiledSchemaReleaseIdentity({ ...input, compiled: selection, prepared });
    await assertCompiledSchemaReleaseIdentity({
      ...input,
      compiled: { releaseId: "new-v3", schemaSha256: "d".repeat(64) },
      prepared,
    });
  });

  it("diagnoses a thrown installed-runtime probe without retaining private provider error details", async () => {
    const input = fixture();
    input.sandbox.run.mockRejectedValue(
      new Error(
        "postgres://private-user:private-password@private-host/private-db token=private-token",
      ),
    );
    const recovery = prepareCanonicalSchemaPredecessorsForSession(input);
    await expect(recovery).rejects.toMatchObject({
      recovery: {
        command: "mise run app:runtime installed spend-review local",
        exitCode: null,
        reason: "execution-failed",
        stage: "probe",
      },
    });
    await expect(recovery).rejects.toThrow("observation command failed before schema compilation");
    try {
      await recovery;
    } catch (error) {
      expect(error).toBeInstanceOf(SchemaPredecessorError);
      expect(JSON.stringify(error)).not.toContain("private-");
    }
    expect(mocks.read).not.toHaveBeenCalled();
    expect(input.sandbox.writeBinaryFile).not.toHaveBeenCalled();
  });

  it.each(["invalid-json", "invalid-shape", "foreign-app"] as const)(
    "diagnoses %s installed receipt without lookup or writes",
    async (kind) => {
      const input = fixture();
      let stdout = JSON.stringify({ ...receipt, appId: "other-app" });
      if (kind === "invalid-json") {
        stdout = "private-invalid-receipt";
      } else if (kind === "invalid-shape") {
        stdout = JSON.stringify({ privateTenant: "private-receipt-secret" });
      }
      input.sandbox.run.mockResolvedValue({ exitCode: 0, stderr: "", stdout });
      await expect(prepareCanonicalSchemaPredecessorsForSession(input)).rejects.toMatchObject({
        recovery: {
          command: "mise run app:runtime installed spend-review local",
          exitCode: 0,
          reason: kind === "foreign-app" ? "app-mismatch" : "invalid-receipt",
          stage: "receipt",
        },
      });
      expect(mocks.read).not.toHaveBeenCalled();
      expect(input.sandbox.writeBinaryFile).not.toHaveBeenCalled();
    },
  );

  it("distinguishes retained-store lookup failure from actual absent immutable history", async () => {
    const input = fixture();
    mocks.read.mockRejectedValue(new Error("private artifact authority unavailable"));
    const recovery = prepareCanonicalSchemaPredecessorsForSession(input);
    await expect(recovery).rejects.toMatchObject({
      recovery: { reason: "lookup-failed", stage: "retained-lookup" },
    });
    await expect(recovery).rejects.toThrow("lookup failed");
    expect(input.sandbox.writeBinaryFile).not.toHaveBeenCalled();
  });

  it("diagnoses restoration write failure without attempting a database command", async () => {
    const input = fixture();
    mocks.read.mockResolvedValue({ files, selection });
    input.sandbox.writeBinaryFile.mockRejectedValue(new Error("private write location"));
    await expect(prepareCanonicalSchemaPredecessorsForSession(input)).rejects.toMatchObject({
      recovery: { reason: "write-failed", stage: "restore" },
    });
    expect(input.sandbox.run).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        command: "mise run app:runtime installed spend-review local",
      }),
    );
  });
});
