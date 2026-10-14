import { createHash } from "node:crypto";
import type { readExactCompiledOperatorReleaseForSession } from "./compiled-operator-artifacts";
import type { SandboxSession } from "eve/sandbox";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { prepareCompiledSchemaPredecessorsForValidationForSession } from "./compiled-schema-validation-input";
import type { CompiledSchemaValidationDependencies } from "./compiled-schema-validation-input";
import type { GeneratedAppReleaseFiles } from "../provisioning/hosted-operator-sandbox-launcher";
import type { CompiledSchemaPredecessorInput } from "./schema-predecessor-state";
import type { CompiledOperatorReleaseSelection } from "../provisioning/hosted-operator-artifact-selection";

interface ValidationFixturePorts {
  canonical: CompiledOperatorReleaseSelection[];
  inputs: Record<string, CompiledSchemaPredecessorInput>;
  read: ReturnType<typeof vi.fn<typeof readExactCompiledOperatorReleaseForSession>>;
}
const mocks: ValidationFixturePorts = {
  canonical: [],
  inputs: {},
  read: vi.fn<typeof readExactCompiledOperatorReleaseForSession>(),
};
const dependencies: CompiledSchemaValidationDependencies = {
  getAppSpec: () => ({ appId: "spend-review", digest: "a".repeat(64) }),
  getCanonicalRefs: () => mocks.canonical,
  getSavedInputs: () => mocks.inputs,
  readOwnedRelease: mocks.read,
  rememberInputs: vi.fn<CompiledSchemaValidationDependencies["rememberInputs"]>(),
};
const artifact = Buffer.from('{"schema":{"app_id":"spend-review","version":"original-v13"}}');
const selection: CompiledOperatorReleaseSelection = {
  appId: "spend-review",
  appSpecDigest: "a".repeat(64),
  artifactRef: `_protected-operator/artifacts/generated-release/spend-review/${"b".repeat(64)}`,
  manifestSha256: "c".repeat(64),
  releaseId: "original-v13",
  schemaSha256: createHash("sha256").update(artifact).digest("hex"),
  version: 1,
};
// Each fixture byte is evaluator-owned synthetic data.
const files: GeneratedAppReleaseFiles = {
  "app-artifact.json": artifact,
  "cue-to-sql-source-map.json": Buffer.from("original:cue-to-sql-source-map.json"),
  "data-operations.md": Buffer.from("original:data-operations.md"),
  "data-operations.ts": Buffer.from("original:data-operations.ts"),
  "data-server.ts": Buffer.from("original:data-server.ts"),
  "operation-manifest.json": Buffer.from("original:operation-manifest.json"),
  "release-manifest.json": Buffer.from("original:release-manifest.json"),
  "runtime-coverage.json": Buffer.from("original:runtime-coverage.json"),
  "sql-bundle.sql": Buffer.from("original:sql-bundle.sql"),
  "sql-manifest.json": Buffer.from("original:sql-manifest.json"),
  "transition-contract.json": Buffer.from("original:transition-contract.json"),
  "transition-plan.json": Buffer.from("original:transition-plan.json"),
};
const fixture = () => ({
  adapterSessionId: "saved-session",
  appId: "spend-review",
  callId: "validate",
  root: "/workspace/repository",
  sandbox: {
    readBinaryFile: vi.fn<SandboxSession["readBinaryFile"]>().mockResolvedValue(null),
    writeBinaryFile: vi.fn<SandboxSession["writeBinaryFile"]>(async () => {}),
  },
  sessionAuth: { owner: "current-owner" },
});
describe("saved successful compilation validation input", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.inputs = {};
    mocks.canonical = [];
    mocks.read.mockResolvedValue({ files, selection });
  });
  it("leaves ordinary and captured empty validation inputs unchanged", async () => {
    const input = fixture();
    expect(
      await prepareCompiledSchemaPredecessorsForValidationForSession(input, dependencies),
    ).toEqual({
      environment: {},
    });
    mocks.inputs["spend-review"] = { predecessors: [] };
    expect(
      await prepareCompiledSchemaPredecessorsForValidationForSession(input, dependencies),
    ).toEqual({
      environment: {},
    });
    expect(mocks.read).not.toHaveBeenCalled();
    expect(input.sandbox.writeBinaryFile).not.toHaveBeenCalled();
  });
  it("restores original v13 input via owned refs after runtime installs v14", async () => {
    mocks.inputs["spend-review"] = { predecessors: [selection] };
    const input = fixture();
    const { environment } = await prepareCompiledSchemaPredecessorsForValidationForSession(
      input,
      dependencies,
    );
    expect(mocks.read).toHaveBeenCalledWith(
      expect.objectContaining({
        adapterSessionId: input.adapterSessionId,
        lookup: { artifactRef: selection.artifactRef },
        sessionAuth: input.sessionAuth,
      }),
    );
    const external = input.sandbox.writeBinaryFile.mock.calls.find(([request]) =>
      request.path.startsWith(".app-builder/"),
    )?.[0];
    expect(external?.content).toEqual(artifact);
    expect(environment.APP_SCHEMA_TRANSITION_PREDECESSOR_FILES).toBe(
      JSON.stringify([`/workspace/${external?.path}`]),
    );
    expect(input.sandbox.writeBinaryFile).toHaveBeenCalledWith(
      expect.objectContaining({
        content: artifact,
        path: "repository/apps/spend-review/schema/release/original-v13/app-artifact.json",
      }),
    );
  });
  it("preserves ordinary live files and restores only actually missing members", async () => {
    mocks.inputs["spend-review"] = { predecessors: [selection] };
    const input = fixture();
    input.sandbox.readBinaryFile.mockResolvedValue(Buffer.from("ordinary live bytes"));
    await prepareCompiledSchemaPredecessorsForValidationForSession(input, dependencies);
    expect(input.sandbox.writeBinaryFile).not.toHaveBeenCalled();
    input.sandbox.readBinaryFile.mockImplementation(
      async ({ path }) =>
        await Promise.resolve(
          path.endsWith("transition-plan.json") ? null : Buffer.from("ordinary live bytes"),
        ),
    );
    await prepareCompiledSchemaPredecessorsForValidationForSession(input, dependencies);
    expect(input.sandbox.writeBinaryFile).toHaveBeenCalledTimes(1);
    expect(input.sandbox.writeBinaryFile).toHaveBeenCalledWith(
      expect.objectContaining({
        content: files["transition-plan.json"],
        path: "repository/apps/spend-review/schema/release/original-v13/transition-plan.json",
      }),
    );
  });
  it("reports unavailable history without selecting another installed release", async () => {
    mocks.inputs["spend-review"] = { predecessors: [selection] };
    mocks.read.mockImplementation(async () => {
      await Promise.resolve();
    });
    const input = fixture();
    await expect(
      prepareCompiledSchemaPredecessorsForValidationForSession(input, dependencies),
    ).rejects.toMatchObject({ recovery: { reason: "missing-history", stage: "retained-lookup" } });
    expect(input.sandbox.writeBinaryFile).not.toHaveBeenCalled();
  });
  it("matches the actual checked manifest among same-artifact captures and recovers a proven self input", async () => {
    const schema = {
      app_id: "spend-review",
      customer_id: "customer",
      models: [],
      version: "current-release",
    };
    const selfArtifact = Buffer.from(JSON.stringify({ schema }));
    const latestManifest = Buffer.from("latest capture manifest");
    const original = {
      ...selection,
      releaseId: schema.version,
      schemaSha256: createHash("sha256").update(selfArtifact).digest("hex"),
    };
    const latest = {
      ...original,
      artifactRef: `_protected-operator/artifacts/generated-release/spend-review/${"e".repeat(64)}`,
      manifestSha256: createHash("sha256").update(latestManifest).digest("hex"),
    };
    const capturedFiles = {
      ...files,
      "app-artifact.json": selfArtifact,
      "release-manifest.json": latestManifest,
      "transition-contract.json": Buffer.from(
        JSON.stringify({
          app_id: schema.app_id,
          customer_id: schema.customer_id,
          predecessors: [
            {
              schema: {
                app_id: schema.app_id,
                customer_id: schema.customer_id,
                models: [],
                version: schema.version,
              },
              version: schema.version,
            },
          ],
          version: schema.version,
        }),
      ),
    };
    mocks.canonical = [original];
    mocks.read.mockImplementation(async (request) => {
      await Promise.resolve();
      if (
        ("artifactRef" in request.lookup && request.lookup.artifactRef === latest.artifactRef) ||
        ("manifestSha256" in request.lookup &&
          request.lookup.manifestSha256 === latest.manifestSha256)
      ) {
        return { files: capturedFiles, selection: latest };
      }
      throw new Error("An earlier manifest cannot select the current capture");
    });
    const input = fixture();
    input.sandbox.readBinaryFile.mockImplementation(async ({ path }) => {
      await Promise.resolve();
      if (path.startsWith(".app-builder/")) {
        return null;
      }
      if (path.endsWith("release-manifest.json")) {
        return latestManifest;
      }
      if (path.endsWith("app-artifact.json")) {
        return selfArtifact;
      }
      return null;
    });
    const result = await prepareCompiledSchemaPredecessorsForValidationForSession(
      input,
      dependencies,
    );
    expect(mocks.read).toHaveBeenCalledWith(
      expect.objectContaining({
        lookup: {
          manifestSha256: latest.manifestSha256,
          releaseId: schema.version,
          schemaSha256: latest.schemaSha256,
        },
      }),
    );
    expect(result.environment.APP_SCHEMA_TRANSITION_PREDECESSOR_FILES).toContain(
      latest.schemaSha256,
    );
    expect(input.sandbox.writeBinaryFile).toHaveBeenCalledTimes(1);
    const write = input.sandbox.writeBinaryFile.mock.calls[0]?.[0];
    expect(write?.content).toEqual(selfArtifact);
    expect(write?.path).toMatch(/^\.app-builder\/schema-predecessors\//u);
  });
  it("keeps missing legacy captures as ordinary validation without restoring target files", async () => {
    mocks.canonical = [selection];
    const input = fixture();
    input.sandbox.readBinaryFile.mockImplementation(
      async ({ path }) =>
        await Promise.resolve(
          path.endsWith("app-artifact.json") ? artifact : Buffer.from("checked manifest"),
        ),
    );
    mocks.read.mockImplementation(async () => {
      await Promise.resolve();
    });
    expect(
      await prepareCompiledSchemaPredecessorsForValidationForSession(input, dependencies),
    ).toEqual({
      environment: {},
    });
    expect(input.sandbox.writeBinaryFile).not.toHaveBeenCalled();
  });
  it("does not infer an external basis from unrelated contract predecessors", async () => {
    const schema = {
      app_id: "spend-review",
      customer_id: "customer",
      version: selection.releaseId,
    };
    mocks.canonical = [selection];
    mocks.read.mockResolvedValue({
      files: {
        ...files,
        "app-artifact.json": Buffer.from(JSON.stringify({ schema })),
        "transition-contract.json": Buffer.from(
          JSON.stringify({
            app_id: schema.app_id,
            customer_id: schema.customer_id,
            predecessors: [
              { schema: { ...schema, version: "other-release" }, version: "other-release" },
            ],
            version: schema.version,
          }),
        ),
      },
      selection,
    });
    const input = fixture();
    input.sandbox.readBinaryFile.mockImplementation(
      async ({ path }) =>
        await Promise.resolve(
          path.endsWith("app-artifact.json") ? artifact : Buffer.from("checked manifest"),
        ),
    );
    expect(
      await prepareCompiledSchemaPredecessorsForValidationForSession(input, dependencies),
    ).toEqual({
      environment: {},
    });
    expect(input.sandbox.writeBinaryFile).not.toHaveBeenCalled();
  });
  it("propagates actual read failures without replacing live source", async () => {
    mocks.inputs["spend-review"] = { predecessors: [selection] };
    const input = fixture();
    input.sandbox.readBinaryFile.mockRejectedValue(new Error("provider unavailable"));
    await expect(
      prepareCompiledSchemaPredecessorsForValidationForSession(input, dependencies),
    ).rejects.toMatchObject({ recovery: { reason: "write-failed", stage: "restore" } });
    expect(input.sandbox.writeBinaryFile).not.toHaveBeenCalled();
  });
});
