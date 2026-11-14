import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { addOptionalTextField } from "../repository/optional-text-field";
import type { OverlayChange } from "../repository/target-apply";
import { GENERATED_RELEASE_MEMBERS } from "./hosted-operator-sandbox-launcher";
import type { GeneratedAppReleaseFiles } from "./hosted-operator-sandbox-launcher";
import { verifyOptionalFieldCorrectionEquivalence } from "./optional-field-correction-equivalence";
import type { OptionalFieldCorrectionFailure } from "./optional-field-correction-equivalence";

const appId = "equipment-log";
const baseVersion = "release-v8";
const releaseVersion = "release-v9";
const prefix = `apps/${appId}/schema`;
const cuePath = `${prefix}/${appId}.cue`;
const releasePath = `${prefix}/release/${releaseVersion}`;
const originalPriorCue = "1".repeat(64);
const originalCandidateCue = "2".repeat(64);
const correctedPriorCue = "3".repeat(64);
const correctedCandidateCue = "4".repeat(64);
const fingerprint = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const sha = (bytes: Buffer) => `sha256:${fingerprint(bytes)}`;
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Serialize only fixture JSON.
const json = (value: unknown) => Buffer.from(JSON.stringify(value));
const optional = {
  id: "calibration_reference",
  label: "Calibration Reference",
  type: "text",
  required: false,
  is_unique: false,
  target_model: null,
  option_set: [],
  lifecycle: "active",
  management: "fixed",
  origin: "app",
};
const model = "entry";

const artifact = (label: string) => ({
  schema: {
    app_id: appId,
    customer_id: "workspace",
    version: baseVersion,
    models: [
      {
        id: model,
        kind: "entity",
        fields: [{ ...optional, id: "creator_actor_id", label, required: true }],
      },
    ],
    change_types: [{ id: "edit", target_model: model, touches: ["creator_actor_id"] }],
  },
  extras: {
    field_metadata: [{ model, field: "creator_actor_id", notes: "" }],
  },
});

type Artifact = ReturnType<typeof artifact>;

const release = (value: Artifact, cueSha256: string, prior?: Artifact) => {
  const { schema } = value;
  const coordinate = { app_id: appId, customer_id: schema.customer_id, version: schema.version };
  const files: GeneratedAppReleaseFiles = {
    "app-artifact.json": json(value),
    "cue-to-sql-source-map.json": json({}),
    "data-operations.md": Buffer.alloc(0),
    "data-operations.ts": Buffer.alloc(0),
    "data-server.ts": Buffer.from("same shared server binding"),
    "operation-manifest.json":
      prior === undefined
        ? json({})
        : json({
            predecessorCompatibility: {
              kind: "optional-text-addition-v1",
              predecessors: [
                {
                  artifactSha256: fingerprint(json(prior)),
                  schema: prior.schema,
                  field: { modelId: model, fieldId: optional.id },
                },
              ],
            },
          }),
    "release-manifest.json": Buffer.alloc(0),
    "runtime-coverage.json": json({}),
    "sql-bundle.sql": Buffer.from("generated SQL"),
    "sql-manifest.json": json({}),
    "transition-contract.json": json({
      ...coordinate,
      predecessors: prior === undefined ? [] : [{ version: baseVersion, schema: prior.schema }],
    }),
    "transition-plan.json": Buffer.alloc(0),
  };
  const plan: typeof coordinate & {
    retirements: string[];
    online_optional_text_addition?: {
      kind: string;
      predecessor_artifact_sha256: string;
      predecessor_schema: Artifact["schema"];
      model_id: string;
      field_id: string;
    };
  } = { ...coordinate, retirements: [] };
  if (prior !== undefined) {
    plan.online_optional_text_addition = {
      kind: "optional-text-addition-v1",
      predecessor_artifact_sha256: fingerprint(json(prior)),
      predecessor_schema: prior.schema,
      model_id: model,
      field_id: optional.id,
    };
  }
  files["transition-plan.json"] = json(plan);
  files["release-manifest.json"] = json({
    app: appId,
    schema_version: schema.version,
    compiler: { version: "1" },
    sources: { [cuePath]: `sha256:${cueSha256}`, "package.json": `sha256:${"5".repeat(64)}` },
    hashes: {
      schema: sha(files["app-artifact.json"]),
      plan: sha(files["transition-plan.json"]),
      transition_contract: sha(files["transition-contract.json"]),
      bundle: sha(files["sql-bundle.sql"]),
      operations: sha(files["operation-manifest.json"]),
      bindings: sha(files["data-operations.ts"]),
      server_bindings: sha(files["data-server.ts"]),
    },
  });
  return {
    files,
    manifestSha256: fingerprint(files["release-manifest.json"]),
    releaseId: schema.version,
  };
};

const pair = (input: {
  existingLabel: string;
  priorCueSha256: string;
  candidateCueSha256: string;
  addedLabel?: string;
  writeEnabled?: boolean;
  notes?: string;
}) => {
  const prior = artifact(input.existingLabel);
  const candidate = structuredClone(prior);
  candidate.schema.version = releaseVersion;
  candidate.schema.models[0].fields.push({
    ...optional,
    label: input.addedLabel ?? optional.label,
  });
  if (input.writeEnabled !== false) {
    candidate.schema.change_types[0].touches.push(optional.id);
  }
  candidate.extras.field_metadata.push({ model, field: optional.id, notes: input.notes ?? "" });
  return {
    prior: release(prior, input.priorCueSha256),
    candidate: release(candidate, input.candidateCueSha256, prior),
    priorCueSha256: input.priorCueSha256,
    candidateCueSha256: input.candidateCueSha256,
  };
};

const edit = (path: string, before: string, after: string): OverlayChange => ({
  path,
  kind: "modified",
  before: { digest: before, mode: "644" },
  after: { digest: after, mode: "644" },
});
type PairOptions = Parameters<typeof pair>[0];
const fixture = (
  correctedOptions: Partial<PairOptions> = {},
  originalOptions: Partial<PairOptions> = {},
) => {
  const original = pair({
    existingLabel: "Creator Actor ID",
    priorCueSha256: originalPriorCue,
    candidateCueSha256: originalCandidateCue,
    ...originalOptions,
  });
  const corrected = pair({
    existingLabel: "Creator actor ID",
    priorCueSha256: correctedPriorCue,
    candidateCueSha256: correctedCandidateCue,
    ...correctedOptions,
  });
  const published = {
    releaseId: corrected.prior.releaseId,
    manifestSha256: corrected.prior.manifestSha256,
    artifactSha256: fingerprint(corrected.prior.files["app-artifact.json"]),
    cueSha256: corrected.priorCueSha256,
  };
  const headChanges = [
    edit(cuePath, original.candidateCueSha256, corrected.candidateCueSha256),
    ...GENERATED_RELEASE_MEMBERS.flatMap((member) => {
      const before = fingerprint(original.candidate.files[member]);
      const after = fingerprint(corrected.candidate.files[member]);
      return before === after ? [] : [edit(`${releasePath}/${member}`, before, after)];
    }),
  ];
  return { appId, original, corrected, installed: published, published, headChanges };
};

const publishedCue = (label: string, trailing = "") =>
  Buffer.from(
    [
      "package schema",
      "",
      "manifest: #AppManifest & {",
      `  version: "${baseVersion}"`,
      `  models: [{id: "${model}", kind: "entity", fields: [{id: "creator_actor_id", label: "${label}", type: "text", required: true}]}]`,
      `  change_types: [{id: "edit", model: "${model}", touches: ["creator_actor_id"]}]`,
      "}",
      trailing,
    ].join("\n"),
  );

const replayFixture = (input: { oldLabel?: string; originalExtraSource?: string } = {}) => {
  const staleCue = publishedCue(input.oldLabel ?? "Creator Actor ID", input.originalExtraSource);
  const publishedPriorCue = publishedCue("Creator actor ID");
  const approvedField = {
    modelId: model,
    fieldId: optional.id,
    label: optional.label,
    changeTypeIds: ["edit"],
  };
  const hashes = (bytes: Buffer) => ({
    priorCueSha256: fingerprint(bytes),
    candidateCueSha256: fingerprint(
      Buffer.from(addOptionalTextField(bytes.toString("utf-8"), approvedField).content),
    ),
  });
  const full = fixture(hashes(publishedPriorCue), {
    ...hashes(staleCue),
    existingLabel: input.oldLabel ?? "Creator Actor ID",
  });
  const { candidate, priorCueSha256, candidateCueSha256 } = full.original;
  return {
    ...full,
    publishedPriorCue,
    original: { candidate, priorCueSha256, candidateCueSha256 },
  };
};

describe("Recompiling an approved optional field against its published predecessor", () => {
  it("keeps the original field and write access while correcting an existing label's casing", () => {
    expect(verifyOptionalFieldCorrectionEquivalence(fixture())).toBe(true);
  });

  it("reports a single closed failure stage for each rejected proof", () => {
    const correct = replayFixture();
    const changedCue = { ...correct.original, priorCueSha256: originalPriorCue };
    const stages: OptionalFieldCorrectionFailure[] = [];
    const report = (stage: OptionalFieldCorrectionFailure) => {
      stages.push(stage);
    };
    expect(verifyOptionalFieldCorrectionEquivalence(correct, report)).toBe(true);
    expect(
      verifyOptionalFieldCorrectionEquivalence({ ...correct, original: changedCue }, report),
    ).toBe(false);
    expect(verifyOptionalFieldCorrectionEquivalence({ ...correct, headChanges: [] }, report)).toBe(
      false,
    );
    correct.corrected.candidate.files["sql-bundle.sql"] = Buffer.from("wrong checked SQL");
    expect(verifyOptionalFieldCorrectionEquivalence(correct, report)).toBe(false);
    expect(stages).toEqual(["original-predecessor-cue", "reviewed-head-diff", "corrected-release"]);
  });

  it.each([
    { existingLabel: "Different old label" },
    { addedLabel: "Different new label" },
    { writeEnabled: false },
    { notes: "New notes" },
  ])("refuses any difference in data behavior or field intent: %j", (change) => {
    expect(verifyOptionalFieldCorrectionEquivalence(fixture(change))).toBe(false);
  });

  it("requires both the actual installation and the published predecessor", () => {
    const correct = fixture();
    expect(
      verifyOptionalFieldCorrectionEquivalence({
        ...correct,
        installed: { ...correct.installed, cueSha256: originalPriorCue },
      }),
    ).toBe(false);
    expect(
      verifyOptionalFieldCorrectionEquivalence({
        ...correct,
        published: { ...correct.published, manifestSha256: "0".repeat(64) },
      }),
    ).toBe(false);
  });

  it("preserves every app source file outside the reviewed CUE and checked generated bytes", () => {
    const correct = fixture();
    const changedAppFile = edit(`apps/${appId}/app/page.tsx`, "a".repeat(64), "b".repeat(64));
    expect(
      verifyOptionalFieldCorrectionEquivalence({
        ...correct,
        headChanges: [...correct.headChanges, changedAppFile],
      }),
    ).toBe(false);
    expect(verifyOptionalFieldCorrectionEquivalence({ ...correct, headChanges: [] })).toBe(false);
    expect(
      verifyOptionalFieldCorrectionEquivalence({
        ...correct,
        headChanges: correct.headChanges.slice(1),
      }),
    ).toBe(false);
    expect(
      verifyOptionalFieldCorrectionEquivalence({
        ...correct,
        headChanges: [
          ...correct.headChanges.slice(1),
          edit(cuePath, originalCandidateCue, "0".repeat(64)),
        ],
      }),
    ).toBe(false);
  });

  it("rejects candidate artifacts that differ from the capture and approved evidence", () => {
    const correct = fixture();
    correct.corrected.candidate.files["sql-bundle.sql"] = Buffer.from("other SQL");
    expect(verifyOptionalFieldCorrectionEquivalence(correct)).toBe(false);
  });

  it("replays the exact approved addition when only the stale predecessor archive is absent", () => {
    expect(verifyOptionalFieldCorrectionEquivalence(replayFixture())).toBe(true);
  });

  it("requires the published predecessor CUE bytes to hash to the installed release", () => {
    const { original, corrected, installed, published, headChanges } = replayFixture();
    const withoutCue = { appId, original, corrected, installed, published, headChanges };
    expect(verifyOptionalFieldCorrectionEquivalence(withoutCue)).toBe(false);
    expect(
      verifyOptionalFieldCorrectionEquivalence({
        ...withoutCue,
        publishedPriorCue: publishedCue("Creator actor ID", "// changed\n"),
      }),
    ).toBe(false);
  });

  it.each([
    { oldLabel: "Changed role identifier" },
    { originalExtraSource: "// unrelated source drift\n" },
  ])("refuses to repair unapproved predecessor changes: %j", (change) => {
    expect(verifyOptionalFieldCorrectionEquivalence(replayFixture(change))).toBe(false);
  });

  it("requires the old grant's exact CUE hashes and original runtime proof", () => {
    const correct = replayFixture();
    expect(
      verifyOptionalFieldCorrectionEquivalence({
        ...correct,
        original: { ...correct.original, priorCueSha256: originalPriorCue },
      }),
    ).toBe(false);
    correct.original.candidate.files["transition-contract.json"] = json({
      predecessors: [{ version: baseVersion, schema: {} }],
    });
    expect(verifyOptionalFieldCorrectionEquivalence(correct)).toBe(false);
  });

  it("does not replace an invalid existing archive with recovered evidence", () => {
    const correct = replayFixture();
    expect(
      verifyOptionalFieldCorrectionEquivalence({
        ...correct,
        original: { ...correct.original, prior: fixture().original.prior },
      }),
    ).toBe(false);
  });
});
