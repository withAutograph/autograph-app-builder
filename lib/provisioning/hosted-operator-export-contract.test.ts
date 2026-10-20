import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import {
  parseTenantExportManifestForWorker,
  tenantExportArtifactManifestSchema,
  tenantExportWorkerDescriptorSchema,
  tenantExportWorkerInputSchema,
  tenantExportWireFixtureSchema,
  hostedTenantExportPlanSchema,
  hostedTenantExportRequestSchema,
  parseHostedTenantExportPlanForOwner,
  parseHostedTenantExportRequestForPlan,
  tenantExportJournalRecordSchema,
  tenantExportPlanDigest,
  tenantExportStatusSchema,
} from "./hosted-operator-export-contract";

const fixtureInput: unknown = JSON.parse(
  readFileSync(new URL("fixtures/tenant-export-wire-v1.json", import.meta.url), "utf-8"),
);
const fixture = tenantExportWireFixtureSchema.parse(fixtureInput);
const copy = () => structuredClone(fixture);
const first = <T>(items: readonly T[]): T => {
  const value = items[0];
  if (value === undefined) {
    throw new Error("Controlled wire fixture member is missing");
  }
  return value;
};
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

test("shared wire roundtrips generic metadata without adding authority or business bytes", () => {
  const value = tenantExportWireFixtureSchema.parse(copy());
  const encoded = JSON.stringify(value);
  const decoded: unknown = JSON.parse(encoded);
  expect(tenantExportWireFixtureSchema.parse(decoded)).toEqual(fixture);
  expect(parseTenantExportManifestForWorker(value.worker, value.manifest)).toEqual(value.manifest);
  expect(hash(JSON.stringify(value.manifest))).toBe(value.manifestMember.sha256);
  expect(String(Buffer.byteLength(JSON.stringify(value.manifest)))).toBe(
    value.manifestMember.byteLength,
  );
});

test("empty tenants and empty files remain successful shapes", () => {
  const value = copy();
  value.manifest.files = [];
  value.manifest.rowCount = "0";
  value.manifest.byteLength = "0";
  expect(parseTenantExportManifestForWorker(value.worker, value.manifest).files).toEqual([]);
  const original = tenantExportArtifactManifestSchema.parse(fixture.manifest);
  expect(original.files[1]?.chunks).toEqual([]);
  expect(original.files[1]?.byteLength).toBe("0");
});

test("authorized business bytes are opaque private chunks, including source-like strings", () => {
  const value = copy();
  const privateBytes =
    '{"note":"postgres://ordinary-business.example/path; SELECT password; Bearer memo; cookie; secret"}\n';
  const sha256 = hash(privateBytes);
  const byteLength = String(Buffer.byteLength(privateBytes));
  const file = first(value.manifest.files);
  file.sha256 = sha256;
  file.byteLength = byteLength;
  file.chunks[0] = {
    index: 0,
    byteLength,
    sha256,
    artifactRef: `_protected-operator/artifacts/tenant-export/${value.worker.exportId}/${value.worker.attemptId}/data/${sha256}`,
  };
  value.manifest.byteLength = byteLength;
  expect(parseTenantExportManifestForWorker(value.worker, value.manifest).files[0]?.sha256).toBe(
    sha256,
  );
  expect(
    tenantExportWorkerInputSchema.safeParse({ ...value.worker, rows: privateBytes }).success,
  ).toBe(false);
});

test("decimal counters preserve large exact totals without a volume quota", () => {
  const value = copy();
  const huge = "999999999999999999999999999999";
  value.manifest.files = [first(value.manifest.files)];
  first(value.manifest.files).rowCount = huge;
  first(value.manifest.files).byteLength = huge;
  first(first(value.manifest.files).chunks).byteLength = huge;
  value.manifest.rowCount = huge;
  value.manifest.byteLength = huge;
  expect(tenantExportArtifactManifestSchema.parse(value.manifest).byteLength).toBe(huge);
  value.manifest.rowCount = "00";
  expect(tenantExportArtifactManifestSchema.safeParse(value.manifest).success).toBe(false);
});

test("foreign scope, attempts, reference digests and traversal are rejected", () => {
  for (const mutate of [
    (value: typeof fixture) => {
      value.manifest.scope.customerId = "another-customer";
    },
    (value: typeof fixture) => {
      value.manifest.resource.database = "another_database";
    },
    (value: typeof fixture) => {
      value.manifest.release.id = "another-release";
    },
    (value: typeof fixture) => {
      value.manifest.attemptId = "90000000-0000-4000-8000-000000000009";
    },
    (value: typeof fixture) => {
      first(value.manifest.files).name = "../outside.ndjson";
    },
    (value: typeof fixture) => {
      first(first(value.manifest.files).chunks).artifactRef += "/../outside";
    },
    (value: typeof fixture) => {
      first(first(value.manifest.files).chunks).sha256 = "f".repeat(64);
    },
    (value: typeof fixture) => {
      value.manifest.byteLength = "0";
    },
  ]) {
    const value = copy();
    mutate(value);
    expect(tenantExportWireFixtureSchema.safeParse(value).success).toBe(false);
  }
});

test("worker metadata cannot become a general credential, SQL or command transport", () => {
  for (const addition of [
    { databaseUrl: "postgres://not-a-real-secret.invalid/db" },
    { sql: "select arbitrary" },
    { env: { APP_MIGRATOR_URL: "not-a-real-secret" } },
    { outputPath: "/caller-selected/output" },
    { ownerUserId: "untrusted-owner" },
  ]) {
    expect(
      tenantExportWorkerInputSchema.safeParse({ ...fixture.worker, ...addition }).success,
    ).toBe(false);
  }
  expect(
    tenantExportWorkerDescriptorSchema.safeParse({
      ...fixture.descriptor,
      subcommand: "protected-generated-app-install",
    }).success,
  ).toBe(false);
  expect(
    tenantExportWorkerDescriptorSchema.safeParse({
      ...fixture.descriptor,
      executablePath: "/opt/../other",
    }).success,
  ).toBe(false);
});

const plan = () =>
  hostedTenantExportPlanSchema.parse({
    version: 1,
    kind: "tenant-export-plan",
    exportId: fixture.worker.exportId,
    planRef: `_protected-operator/export-plans/${fixture.worker.exportId}`,
    authority: {
      issuer: "issuer-fixture",
      audience: "audience-fixture",
      workspaceId: "workspace-fixture",
      ownerUserId: "owner-fixture",
    },
    // Provider resource project/branch and repository target project/branch are distinct identities.
    target: {
      sessionId: "saved-session-fixture",
      appId: fixture.worker.scope.appId,
      projectId: "vercel-app-project",
      branch: "published-app-branch",
    },
    originalSetup: {
      operationRef: "40000000-0000-4000-8000-000000000004",
      planDigest: "1".repeat(64),
      approvalId: "original-setup-approval",
      approvedByCallId: "original-setup-call",
    },
    scope: structuredClone(fixture.worker.scope),
    resource: structuredClone(fixture.worker.resource),
    release: structuredClone(fixture.worker.release),
    selection: "public-app-customer-tables-v1",
    format: "ndjson",
    destination: {
      kind: "owner-private-builder-artifact",
      artifactPrefix: `_protected-operator/artifacts/tenant-export/${fixture.worker.exportId}`,
    },
  });
const journal = () => {
  const planned = plan();
  const planDigest = tenantExportPlanDigest(planned);
  return {
    kind: "app-export",
    version: 1,
    requestId: planned.exportId,
    authority: planned.authority,
    target: planned.target,
    plan: planned,
    planDigest,
    idempotencyKey: "saved-export-tool-call",
    revision: 0,
    fenceGeneration: 0,
    state: "planned",
    attempts: [],
  };
};

test("only opaque intent fields enter the untrusted request and equivalent plan ordering preserves its digest", () => {
  const planned = plan();
  const request = hostedTenantExportRequestSchema.parse({
    action: "export",
    planRef: planned.planRef,
    planDigest: tenantExportPlanDigest(planned),
    idempotencyKey: "saved-export-tool-call",
  });
  expect(parseHostedTenantExportRequestForPlan(request, planned)).toEqual(request);
  expect(
    tenantExportPlanDigest(
      hostedTenantExportPlanSchema.parse(Object.fromEntries(Object.entries(planned).toReversed())),
    ),
  ).toBe(request.planDigest);
  for (const addition of [
    { authority: planned.authority },
    { scope: planned.scope },
    { url: "https://foreign.invalid" },
    { sql: "select arbitrary" },
    { env: {} },
    { outputPath: "/caller-selected/output" },
    { approvalId: "caller-claims-approval" },
  ]) {
    expect(hostedTenantExportRequestSchema.safeParse({ ...request, ...addition }).success).toBe(
      false,
    );
  }
  expect(() =>
    parseHostedTenantExportRequestForPlan({ ...request, planDigest: "f".repeat(64) }, planned),
  ).toThrow("tenant_export_intent_mismatch");
  expect(() =>
    parseHostedTenantExportRequestForPlan(request, {
      ...planned,
      scope: { ...planned.scope, customerId: "foreign-customer" },
    }),
  ).toThrow("tenant_export_intent_mismatch");
});

test("owner/session and original setup remain separate from the new export journal identity", () => {
  const planned = plan();
  expect(
    parseHostedTenantExportPlanForOwner(planned, {
      authority: planned.authority,
      target: planned.target,
    }),
  ).toEqual(planned);
  const laterTarget = {
    ...planned.target,
    branch: "later-normal-branch",
    projectId: "later-target-metadata",
  };
  expect(
    parseHostedTenantExportPlanForOwner(planned, {
      authority: planned.authority,
      target: laterTarget,
    }),
  ).toEqual(planned);
  expect(() =>
    parseHostedTenantExportPlanForOwner(planned, {
      authority: { ...planned.authority, ownerUserId: "foreign-owner" },
      target: planned.target,
    }),
  ).toThrow("tenant_export_owner_mismatch");
  expect(() =>
    parseHostedTenantExportPlanForOwner(planned, {
      authority: planned.authority,
      target: { ...planned.target, sessionId: "foreign-session" },
    }),
  ).toThrow("tenant_export_owner_mismatch");
  expect(
    hostedTenantExportPlanSchema.safeParse({
      ...planned,
      originalSetup: { ...planned.originalSetup, operationRef: planned.exportId },
    }).success,
  ).toBe(false);
  expect(
    hostedTenantExportPlanSchema.safeParse({
      ...planned,
      destination: { ...planned.destination, artifactPrefix: "../foreign" },
    }).success,
  ).toBe(false);
  expect(tenantExportJournalRecordSchema.parse(journal()).state).toBe("planned");
  expect(
    tenantExportJournalRecordSchema.safeParse({
      ...journal(),
      plan: { ...planned, destination: { ...planned.destination, artifactPrefix: "../foreign" } },
    }).success,
  ).toBe(false);
  const foreign = journal();
  foreign.authority = { ...foreign.authority, ownerUserId: "foreign-owner" };
  expect(tenantExportJournalRecordSchema.safeParse(foreign).success).toBe(false);
});

test("reading and completion require exact export intent approval, own attempt and matching private manifest", () => {
  const original = journal();
  const approval = {
    action: "export",
    planRef: original.plan.planRef,
    planDigest: original.planDigest,
    idempotencyKey: original.idempotencyKey,
    approvalId: "export-approval",
    approvedByCallId: "export-call",
  };
  const attempt = {
    attemptId: fixture.worker.attemptId,
    snapshotId: fixture.worker.snapshotId,
    state: "complete",
  };
  const complete = {
    ...original,
    state: "complete",
    approval,
    attempts: [attempt],
    completion: {
      attemptId: attempt.attemptId,
      snapshotId: attempt.snapshotId,
      manifest: fixture.manifestMember,
      fileCount: "2",
      rowCount: fixture.manifest.rowCount,
      byteLength: fixture.manifest.byteLength,
    },
  };
  expect(tenantExportJournalRecordSchema.parse(complete).state).toBe("complete");
  for (const changed of [
    { ...complete, approval: undefined },
    { ...complete, approval: { ...approval, action: "prepare" } },
    { ...complete, approval: { ...approval, idempotencyKey: "another-export-intent" } },
    { ...complete, completion: undefined },
    {
      ...complete,
      completion: { ...complete.completion, snapshotId: "50000000-0000-4000-8000-000000000005" },
    },
    {
      ...complete,
      claim: {
        claimId: "60000000-0000-4000-8000-000000000006",
        attemptId: attempt.attemptId,
        fenceGeneration: 2,
      },
    },
    { ...complete, state: "reading" },
  ]) {
    expect(tenantExportJournalRecordSchema.safeParse(changed).success).toBe(false);
  }
});

test("unknown progress counts stay absent and only durable completion exposes the owner download index", () => {
  const planned = plan();
  const status = { exportId: planned.exportId, planRef: planned.planRef, state: "reading" };
  expect(tenantExportStatusSchema.parse(status).counts).toBeUndefined();
  const download = { indexPath: `/api/hosted-operator/exports/${planned.exportId}` };
  expect(tenantExportStatusSchema.safeParse({ ...status, download }).success).toBe(false);
  expect(
    tenantExportStatusSchema.safeParse({ ...status, state: "complete", download }).success,
  ).toBe(false);
  expect(
    tenantExportStatusSchema.parse({
      ...status,
      state: "complete",
      counts: { fileCount: "0", rowCount: "0", byteLength: "0" },
      download,
    }).counts?.rowCount,
  ).toBe("0");
  expect(
    tenantExportStatusSchema.safeParse({
      ...status,
      state: "complete",
      counts: { fileCount: "0", rowCount: "0", byteLength: "0" },
      download: { indexPath: "https://foreign.invalid/export" },
    }).success,
  ).toBe(false);
});

test("invalid counters and foreign release references fail closed without interpreting row content", () => {
  for (const countValue of ["not-a-number", "-1", "1.5", "00"]) {
    const value = copy();
    value.manifest.byteLength = countValue;
    expect(tenantExportArtifactManifestSchema.safeParse(value.manifest).success).toBe(false);
  }
  const value = copy();
  value.worker.release.manifestRef = value.worker.release.manifestRef.replace(
    "/orchard/",
    "/another-app/",
  );
  expect(tenantExportWorkerInputSchema.safeParse(value.worker).success).toBe(false);
  expect(
    tenantExportWorkerDescriptorSchema.parse({
      ...fixture.descriptor,
      id: "reviewed-export-worker-build-2",
    }).id,
  ).toBe("reviewed-export-worker-build-2");
});
