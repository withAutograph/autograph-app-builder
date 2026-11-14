import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  assertOptionalTextProductionTransition,
  readOptionalTextReleasePredecessor,
} from "./repository-production-schema-revision";
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
    runtimeProof?: "missing" | "wrong-field" | "wrong-artifact";
    sharedSource?: string;
    predecessors?: { version: string; schema: typeof beforeArtifact.schema }[];
  } = {},
) => {
  const { schema } = artifact;
  const coordinate = { app_id: appId, customer_id: schema.customer_id, version: schema.version };
  const manifest =
    schema.version === beforeVersion || options.runtimeProof === "missing"
      ? {}
      : {
          predecessorCompatibility: {
            kind: "optional-text-addition-v1",
            predecessors: [
              {
                artifactSha256:
                  options.runtimeProof === "wrong-artifact"
                    ? "0".repeat(64)
                    : hex(json(beforeArtifact)),
                schema: beforeArtifact.schema,
                field: {
                  modelId: "entry",
                  fieldId: options.runtimeProof === "wrong-field" ? "title" : textField.id,
                },
              },
            ],
          },
        };
  const files: GeneratedAppReleaseFiles = {
    "app-artifact.json": json(artifact),
    "cue-to-sql-source-map.json": json({}),
    "data-operations.md": Buffer.alloc(0),
    "data-operations.ts": Buffer.alloc(0),
    "data-server.ts": Buffer.alloc(0),
    "operation-manifest.json": json(manifest),
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
    sources: {
      [`apps/${appId}/schema/${appId}.cue`]: `sha256:${cueSha256}`,
      ".config/mise/scripts/repository/schema-release.ts": `sha256:${cueSha256}`,
      "packages/schema-compiler/cue/app-manifest.cue": `sha256:${options.sharedSource ?? priorCueSha256}`,
    },
    hashes: {
      schema: `sha256:${hex(files["app-artifact.json"])}`,
      plan: `sha256:${hex(files["transition-plan.json"])}`,
      transition_contract: `sha256:${hex(files["transition-contract.json"])}`,
      bundle: `sha256:${hex(files["sql-bundle.sql"])}`,
      operations: `sha256:${hex(files["operation-manifest.json"])}`,
      bindings: `sha256:${hex(files["data-operations.ts"])}`,
      server_bindings: `sha256:${hex(files["data-server.ts"])}`,
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

describe("Checked online optional field evidence", () => {
  const withTransition = (runtimeProof?: "missing" | "wrong-field" | "wrong-artifact") => {
    const candidate = release(
      candidateArtifact(),
      candidateCueSha256,
      runtimeProof === undefined ? {} : { runtimeProof },
    );
    const artifactSha256 = hex(json(beforeArtifact));
    candidate.files["transition-plan.json"] = json({
      online_optional_text_addition: {
        kind: "optional-text-addition-v1",
        predecessor_artifact_sha256: artifactSha256,
        predecessor_schema: beforeArtifact.schema,
        model_id: "entry",
        field_id: textField.id,
      },
    });
    return { files: candidate.files, artifactSha256 };
  };

  it("locates the same predecessor only when both generated artifacts agree", () => {
    const { files, artifactSha256 } = withTransition();
    expect(readOptionalTextReleasePredecessor(files)).toEqual({
      artifactSha256,
      releaseId: beforeVersion,
    });
    expect(
      readOptionalTextReleasePredecessor(release(candidateArtifact(), candidateCueSha256).files),
    ).toBeNull();
  });

  it.each(["missing", "wrong-field", "wrong-artifact"] as const)(
    "refuses %s runtime evidence even when the online transition is present",
    (runtimeProof) => {
      expect(readOptionalTextReleasePredecessor(withTransition(runtimeProof).files)).toBeNull();
    },
  );
});

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

  it.each(["missing", "wrong-field", "wrong-artifact"] as const)(
    "rejects runtime compatibility evidence that is %s",
    (runtimeProof) => {
      expect(() => {
        verify(release(candidateArtifact(), candidateCueSha256, { runtimeProof }));
      }).toThrow(rejection);
    },
  );

  it("preserves the other reviewed compiler inputs and bindings", () => {
    expect(() => {
      verify(release(candidateArtifact(), candidateCueSha256, { sharedSource: "0".repeat(64) }));
    }).toThrow(rejection);
    const candidate = release(candidateArtifact(), candidateCueSha256);
    candidate.files["data-operations.ts"] = Buffer.from("different runtime bindings");
    expect(() => {
      verify(candidate);
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
