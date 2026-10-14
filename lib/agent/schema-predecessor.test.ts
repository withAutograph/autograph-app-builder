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
      expect.objectContaining({
        command: "mise run app:runtime resume-installed spend-review local",
      }),
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
        command: "mise run app:runtime resume-installed spend-review local",
        diagnostic: "private runtime unavailable",
        diagnosticLength: 27,
        diagnosticPresent: true,
        diagnosticTruncated: false,
        exitCode: 1,
        outputPresence: { stderr: true, stdout: false },
        reason: "command-failed",
        stage: "probe",
      },
    });
    expect(mocks.read).not.toHaveBeenCalled();
    expect(input.sandbox.writeBinaryFile).not.toHaveBeenCalled();
  });
  it("retains only a capped safe summary and output-presence flags for failed commands", async () => {
    const input = fixture();
    const jwt = `eyJ${"a".repeat(12)}.eyJ${"b".repeat(12)}.eyJ${"c".repeat(12)}`;
    input.sandbox.run.mockResolvedValue({
      exitCode: 1,
      stderr: [
        "runtime probe failed",
        "DATABASE_URL=postgres://private-user:private-password@private-host/private-db?token=secret",
        "Authorization: Bearer private-bearer",
        `session=${jwt}`,
        'provider response: {"receipt":"private-provider-payload","secret":"hidden"}',
        'provider error: { "nested": {',
        '  "inner": "private-inner-canary"',
        "  },",
        '  "privateOuter": "private-outer-canary"',
        "} trailing text",
        "provider error: {",
        "  message: 'unexpected } token',",
        "  project: 'private-project-canary',",
        "}",
        "provider error details:",
        "{",
        '  "installationId": "private-installation-id",',
        '  "payload": {"token": "private-nested-token"}',
        "}",
        `diagnostic ${"x".repeat(1200)}\u0001`,
      ].join("\n"),
      stdout: JSON.stringify({ receipt: "never expose stdout receipt" }),
    });
    const pending = prepareCanonicalSchemaPredecessorsForSession(input);
    let failure: SchemaPredecessorError | undefined;
    try {
      await pending;
    } catch (error) {
      if (error instanceof SchemaPredecessorError) {
        failure = error;
      } else {
        throw error;
      }
    }
    expect(failure).toBeInstanceOf(SchemaPredecessorError);
    if (!failure) {
      throw new Error("Expected predecessor probe failure.");
    }
    expect(failure.recovery).toMatchObject({
      command: "mise run app:runtime resume-installed spend-review local",
      diagnosticPresent: true,
      diagnosticTruncated: true,
      exitCode: 1,
      outputPresence: { stderr: true, stdout: true },
      reason: "command-failed",
      stage: "probe",
    });
    expect(failure.recovery?.diagnosticLength).toBeGreaterThan(800);
    if (failure.recovery?.diagnostic === undefined) {
      throw new Error("Expected a bounded command diagnostic.");
    }
    const serialized = JSON.stringify(failure);
    expect(serialized).not.toContain("private-user");
    expect(serialized).not.toContain("private-password");
    expect(serialized).not.toContain("private-host");
    expect(serialized).not.toContain("private-db");
    expect(serialized).not.toContain("private-bearer");
    expect(serialized).not.toContain(jwt);
    expect(serialized).not.toContain("private-provider-payload");
    expect(serialized).not.toContain("private-inner-canary");
    expect(serialized).not.toContain("private-outer-canary");
    expect(serialized).not.toContain("private-project-canary");
    expect(serialized).not.toContain("private-installation-id");
    expect(serialized).not.toContain("private-nested-token");
    expect(serialized).not.toContain("never expose stdout receipt");
    expect(serialized).not.toContain("hidden");
    expect(serialized).not.toContain("\u0001");
    expect(serialized).toContain("DATABASE_URL=[REDACTED]");
    expect(serialized).toContain("Authorization: [REDACTED]");
    expect(serialized).toContain("[JWT REDACTED]");
    expect(serialized).toContain("[structured output redacted]");
    expect(serialized).toContain("[truncated]");
    expect(serialized.length).toBeLessThan(2000);
    expect(mocks.read).not.toHaveBeenCalled();
    expect(input.sandbox.writeBinaryFile).not.toHaveBeenCalled();
  });
  it("marks a failed probe with no returned output instead of implying output was captured", async () => {
    const input = fixture();
    input.sandbox.run.mockResolvedValue({ exitCode: 1, stderr: "", stdout: "" });
    await expect(prepareCanonicalSchemaPredecessorsForSession(input)).rejects.toMatchObject({
      recovery: {
        command: "mise run app:runtime resume-installed spend-review local",
        diagnosticLength: 0,
        diagnosticPresent: false,
        diagnosticTruncated: false,
        exitCode: 1,
        outputPresence: { stderr: false, stdout: false },
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
    let failure: SchemaPredecessorError | undefined;
    try {
      await recovery;
    } catch (error) {
      if (error instanceof SchemaPredecessorError) {
        failure = error;
      } else {
        throw error;
      }
    }
    expect(failure).toBeInstanceOf(SchemaPredecessorError);
    if (!failure) {
      throw new Error("Expected predecessor probe failure.");
    }
    expect(failure.recovery).toMatchObject({
      command: "mise run app:runtime resume-installed spend-review local",
      diagnosticPresent: true,
      diagnosticTruncated: false,
      exitCode: null,
      outputPresence: { stderr: false, stdout: false },
      reason: "execution-failed",
      stage: "probe",
    });
    expect(failure.recovery?.diagnosticLength).toBeGreaterThan(0);
    expect(failure.message).toContain("observation command failed before schema compilation");
    expect(JSON.stringify(failure)).not.toContain("private-");
    expect(JSON.stringify(failure)).toContain("[URL REDACTED]");
    expect(JSON.stringify(failure)).toContain("token=[REDACTED]");
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
          command: "mise run app:runtime resume-installed spend-review local",
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
        command: "mise run app:runtime resume-installed spend-review local",
      }),
    );
  });
});
