/* oxlint-disable anti-slop/no-module-mocking -- Exercise owned capture and state selection without hosted storage. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GeneratedAppReleaseFiles } from "../provisioning/hosted-operator-sandbox-launcher";
import type { CompiledOperatorReleaseSelection } from "../provisioning/hosted-operator-artifact-selection";
import type { readExactCompiledOperatorReleaseForSession } from "./compiled-operator-artifacts";
import { readConnectedSchemaSavedPredecessor } from "./connected-schema-saved-predecessor";
import type { CompiledSchemaPredecessorInput } from "./schema-predecessor-state";

const state = vi.hoisted(() => {
  const canonical: CompiledOperatorReleaseSelection[] = [];
  const saved: Record<string, CompiledSchemaPredecessorInput> = {};
  return { canonical, saved, read: vi.fn<typeof readExactCompiledOperatorReleaseForSession>() };
});
vi.mock("./schema-predecessor-state", () => ({
  canonicalSchemaPredecessorState: { get: () => state.canonical },
  compiledSchemaPredecessorState: { get: () => state.saved },
}));
vi.mock("./compiled-operator-artifacts", () => ({
  readExactCompiledOperatorReleaseForSession: state.read,
}));

const appId = "fixture-app";
const appSpecDigest = "a".repeat(64);
const cueSha256 = "2".repeat(64);
const input = {
  expectedCueSha256: cueSha256,
  appId,
  appSpecDigest,
  adapterSessionId: "saved-session",
  callId: "compile",
  root: "/workspace/repository",
  sessionAuth: { owner: "fixture-owner" },
};
const prior: CompiledOperatorReleaseSelection = {
  appId,
  appSpecDigest,
  artifactRef: `_protected-operator/artifacts/generated-release/${appId}/${"b".repeat(64)}`,
  manifestSha256: "c".repeat(64),
  releaseId: "fixture-v8",
  schemaSha256: "d".repeat(64),
  version: 1,
};
const candidate = {
  ...prior,
  artifactRef: `_protected-operator/artifacts/generated-release/${appId}/${"e".repeat(64)}`,
  manifestSha256: "f".repeat(64),
  releaseId: "fixture-v9",
  schemaSha256: "9".repeat(64),
};

const proofFiles = (matching: boolean): GeneratedAppReleaseFiles => {
  const schema = { version: prior.releaseId };
  const plan = {
    online_optional_text_addition: {
      kind: "optional-text-addition-v1",
      predecessor_artifact_sha256: prior.schemaSha256,
      predecessor_schema: schema,
      model_id: "fixture",
      field_id: "label",
    },
  };
  const operations = {
    predecessorCompatibility: {
      kind: "optional-text-addition-v1",
      predecessors: [
        {
          artifactSha256: prior.schemaSha256,
          schema,
          field: { modelId: "fixture", fieldId: matching ? "label" : "other" },
        },
      ],
    },
  };
  const bytes = Buffer.from("fixture");
  return {
    "app-artifact.json": bytes,
    "cue-to-sql-source-map.json": bytes,
    "data-operations.md": bytes,
    "data-operations.ts": bytes,
    "data-server.ts": bytes,
    "operation-manifest.json": Buffer.from(JSON.stringify(operations)),
    "release-manifest.json": Buffer.from(
      JSON.stringify({ sources: { [`apps/${appId}/schema/${appId}.cue`]: `sha256:${cueSha256}` } }),
    ),
    "runtime-coverage.json": bytes,
    "sql-bundle.sql": bytes,
    "sql-manifest.json": bytes,
    "transition-contract.json": bytes,
    "transition-plan.json": Buffer.from(JSON.stringify(plan)),
  };
};

describe("connected schema capture predecessor", () => {
  beforeEach(() => {
    state.saved = { [appId]: { compiled: candidate, predecessors: [candidate] } };
    state.canonical = [prior];
    state.read.mockReset().mockResolvedValue({ selection: candidate, files: proofFiles(true) });
  });

  it("uses matched compiler evidence when private validation retained the candidate as its own predecessor", async () => {
    await expect(readConnectedSchemaSavedPredecessor(input)).resolves.toEqual({
      candidate,
      prior: {
        onlineProof: true,
        artifactSha256: prior.schemaSha256,
        previousManifestSha256: prior.manifestSha256,
        releaseId: prior.releaseId,
      },
    });
    expect(state.read).toHaveBeenCalledWith({
      adapterSessionId: input.adapterSessionId,
      appId,
      appSpecDigest,
      callId: input.callId,
      root: input.root,
      sessionAuth: input.sessionAuth,
      lookup: { artifactRef: candidate.artifactRef, appSpecDigest },
    });
  });

  it("omits ambiguous canonical history and accepts one explicit prior for a legacy cut", async () => {
    state.canonical = [prior, { ...prior, manifestSha256: "7".repeat(64) }];
    await expect(readConnectedSchemaSavedPredecessor(input)).resolves.toEqual({
      candidate,
      prior: { artifactSha256: prior.schemaSha256, onlineProof: true, releaseId: prior.releaseId },
    });
    state.saved = { [appId]: { compiled: candidate, predecessors: [candidate, prior] } };
    state.read.mockResolvedValue({ selection: candidate, files: proofFiles(false) });
    await expect(readConnectedSchemaSavedPredecessor(input)).resolves.toMatchObject({
      candidate,
      prior: {
        releaseId: prior.releaseId,
        onlineProof: false,
        previousManifestSha256: prior.manifestSha256,
      },
    });
  });

  it("requires the owning specification and exact saved capture identity", async () => {
    await expect(
      readConnectedSchemaSavedPredecessor({ ...input, appSpecDigest: "8".repeat(64) }),
    ).resolves.toBeNull();
    expect(state.read).not.toHaveBeenCalled();
    await expect(
      readConnectedSchemaSavedPredecessor({ ...input, expectedCueSha256: "3".repeat(64) }),
    ).resolves.toBeNull();
    state.read.mockResolvedValue({ selection: prior, files: proofFiles(true) });
    await expect(readConnectedSchemaSavedPredecessor(input)).resolves.toBeNull();
  });
});
