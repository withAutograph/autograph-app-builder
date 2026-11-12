import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { assertOptionalTextProductionTransition } from "./repository-production-schema-revision";
import type { GeneratedAppReleaseFiles } from "./hosted-operator-sandbox-launcher";

const appId = "test-app";
const beforeVersion = "release-1";
const nextVersion = "release-2";
const priorCueSha256 = "1".repeat(64);
const candidateCueSha256 = "2".repeat(64);
const rejection = "repository_production_schema_revision_unverified";
const textField = {
  id: "note",
  label: "Note",
  type: "text",
  required: false,
  is_unique: false,
  target_model: null,
  option_set: [],
  lifecycle: "active",
  management: "fixed",
  origin: "app",
};
const beforeArtifact = {
  schema: {
    app_id: appId,
    customer_id: "workspace",
    version: beforeVersion,
    models: [
      { id: "entry", kind: "entity", fields: [{ ...textField, id: "title", required: true }] },
    ],
    change_types: [{ id: "edit", target_model: "entry", touches: ["title"] }],
  },
  extras: { field_metadata: [{ model: "entry", field: "title" }] },
};
const candidateArtifact = () => {
  const artifact = structuredClone(beforeArtifact);
  artifact.schema.version = nextVersion;
  artifact.schema.models[0].fields.push(textField);
  artifact.schema.change_types[0].touches.push(textField.id);
  artifact.extras.field_metadata.push({ model: "entry", field: textField.id });
  return artifact;
};
const hex = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Accept JSON test fixture values for serialization.
const json = (value: unknown) => Buffer.from(JSON.stringify(value));
const release = (
  artifact: typeof beforeArtifact,
  cueSha256: string,
  options: {
    retirements?: string[];
    predecessors?: { version: string; schema: typeof beforeArtifact.schema }[];
  } = {},
) => {
  const { schema } = artifact;
  const coordinate = { app_id: appId, customer_id: schema.customer_id, version: schema.version };
  const files: GeneratedAppReleaseFiles = {
    "app-artifact.json": json(artifact),
    "cue-to-sql-source-map.json": json({}),
    "data-operations.md": Buffer.alloc(0),
    "data-operations.ts": Buffer.alloc(0),
    "data-server.ts": Buffer.alloc(0),
    "operation-manifest.json": json({}),
    "release-manifest.json": Buffer.alloc(0),
    "runtime-coverage.json": json({}),
    "sql-bundle.sql": Buffer.from("generated SQL"),
    "sql-manifest.json": json({}),
    "transition-contract.json": json({
      ...coordinate,
      predecessors: options.predecessors ?? [
        { version: beforeVersion, schema: beforeArtifact.schema },
      ],
    }),
    "transition-plan.json": json({ ...coordinate, retirements: options.retirements ?? [] }),
  };
  files["release-manifest.json"] = json({
    app: appId,
    schema_version: schema.version,
    compiler: { version: "1" },
    sources: { [`apps/${appId}/schema/${appId}.cue`]: `sha256:${cueSha256}` },
    hashes: {
      schema: `sha256:${hex(files["app-artifact.json"])}`,
      plan: `sha256:${hex(files["transition-plan.json"])}`,
      transition_contract: `sha256:${hex(files["transition-contract.json"])}`,
      bundle: `sha256:${hex(files["sql-bundle.sql"])}`,
    },
  });
  return { files, releaseId: schema.version, manifestSha256: hex(files["release-manifest.json"]) };
};
const verify = (candidate: ReturnType<typeof release>) => {
  assertOptionalTextProductionTransition({
    appId,
    candidate,
    candidateCueSha256,
    prior: release(beforeArtifact, priorCueSha256),
    priorCueSha256,
  });
};

describe("Exact optional text schema transition", () => {
  it("accepts an optional field and its existing edit operation", () => {
    expect(() => {
      verify(release(candidateArtifact(), candidateCueSha256));
    }).not.toThrow();
  });

  it.each(["required", "is_unique"] as const)("rejects an added %s field", (property) => {
    const candidate = candidateArtifact();
    candidate.schema.models[0].fields[1] = { ...textField, [property]: true };
    expect(() => {
      verify(release(candidate, candidateCueSha256));
    }).toThrow(rejection);
  });

  it("rejects existing-field changes, retired data, or a different predecessor", () => {
    const altered = candidateArtifact();
    altered.schema.models[0].fields[0].label = "New title";
    expect(() => {
      verify(release(altered, candidateCueSha256));
    }).toThrow(rejection);
    expect(() => {
      verify(release(candidateArtifact(), candidateCueSha256, { retirements: ["title"] }));
    }).toThrow(rejection);
    expect(() => {
      verify(release(candidateArtifact(), candidateCueSha256, { predecessors: [] }));
    }).toThrow(rejection);
  });

  it("rejects mismatched reviewed source and unbound SQL bytes", () => {
    expect(() => {
      verify(release(candidateArtifact(), priorCueSha256));
    }).toThrow(rejection);
    const candidate = release(candidateArtifact(), candidateCueSha256);
    candidate.files["sql-bundle.sql"] = Buffer.from("different SQL");
    expect(() => {
      verify(candidate);
    }).toThrow(rejection);
  });
});
