/* oxlint-disable eslint/require-await -- Synthetic transport ports preserve asynchronous failures without provider effects. */
import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { runRepositoryProductionFileSpool } from "./hosted-operator-sandbox-launcher";
import type {
  ProtectedInstallerWorkerDescriptor,
  ResourceBootstrapContextWire,
} from "./hosted-operator-sandbox-launcher";

const privateCredentials = Buffer.from("synthetic private role credentials");
const runId = "11111111-1111-4111-a111-111111111111";
const worker: ProtectedInstallerWorkerDescriptor = {
  executablePath: "/worker/resource",
  id: "neon-resource-bootstrap-v1",
  operationScope: "neon-resource-bootstrap-v1",
  sha256: "a".repeat(64),
  subcommand: "neon-resource-bootstrap",
};
const context: ResourceBootstrapContextWire = {
  version: 1,
  kind: "neon_resource_bootstrap",
  app_id: "synthetic-requests",
  operation: { operation_id: runId, approval_digest: "b".repeat(64), fence_generation: 1 },
  resource: {
    resource_id: "owned-resource",
    environment: "production",
    scope: "app_database",
    hostname: "ep-fixture.neon.tech",
    port: 5432,
    database: "app_requests",
    migrator_role: "app_migrator",
    runtime_role: "app_runtime",
    provider_project_id: "fixture-project",
    provider_branch_id: "fixture-branch",
    maintenance_database: "neondb",
    bootstrap_role: "maintenance",
    provider_endpoint_id: "ep-fixture",
    credentials_sha256: createHash("sha256").update(privateCredentials).digest("hex"),
  },
  release: { id: "fixture-release", sha256: "c".repeat(64) },
  installer: { id: worker.id, sha256: worker.sha256 },
  tenant_targets: [],
};
const input = () => ({
  operation: "storage" as const,
  worker,
  context,
  startupFiles: {},
  directDatabaseUrl:
    "postgresql://maintenance:private-fixture-password@ep-fixture.neon.tech/neondb",
  resourceCredentialBytes: privateCredentials,
  readOnly: false,
  runId,
  signal: new AbortController().signal,
  assertCurrent: vi.fn(async () => {}),
  recordCheckpoint: vi.fn(async () => {}),
});
const configuration = {
  image: "fixture-image",
  projectId: "operator",
  teamId: "team",
  workers: {},
};

afterEach(() => vi.restoreAllMocks());

it("reports a Sandbox-create status without exposing the provider failure or credentials", async () => {
  const log = vi.spyOn(console, "warn").mockImplementation(() => {});
  const original = Object.assign(
    new Error("private provider response including a private bearer"),
    { statusCode: 403 },
  );
  const createSandbox = vi.fn(async () => {
    throw original;
  });
  const request = input();
  await expect(
    runRepositoryProductionFileSpool(configuration, request, { createSandbox }),
  ).rejects.toMatchObject({ code: "operator_unavailable" });
  expect(createSandbox).toHaveBeenCalledTimes(1);
  expect(request.recordCheckpoint).not.toHaveBeenCalled();
  const output = log.mock.calls.flat().join("");
  expect(output).toContain('"phase":"sandbox_create"');
  expect(output).toContain('"httpStatus":403');
  expect(output).not.toContain("private");
  expect(output).not.toContain("postgresql:");
});

it("preserves the transport failure when diagnostics are unavailable", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {
    throw new Error("logger unavailable");
  });
  const createSandbox = vi.fn(async () => {
    throw new Error("provider unavailable");
  });
  await expect(
    runRepositoryProductionFileSpool(configuration, input(), { createSandbox }),
  ).rejects.toMatchObject({ code: "operator_unavailable" });
  expect(createSandbox).toHaveBeenCalledTimes(1);
});

it("identifies an existing transport scope refusal without dispatch or private context", async () => {
  const log = vi.spyOn(console, "warn").mockImplementation(() => {});
  const createSandbox = vi.fn(async () => {
    throw new Error("must not launch");
  });
  const request = input();
  request.context = {
    ...context,
    resource: { ...context.resource, environment: "preview" },
  };
  await expect(
    runRepositoryProductionFileSpool(configuration, request, { createSandbox }),
  ).rejects.toMatchObject({ code: "resource_mismatch" });
  expect(createSandbox).not.toHaveBeenCalled();
  expect(request.recordCheckpoint).not.toHaveBeenCalled();
  const output = log.mock.calls.flat().join("");
  expect(output).toContain('"phase":"worker_transport_validation"');
  expect(output).not.toContain(context.resource.hostname);
  expect(output).not.toContain(context.resource.database);
  expect(output).not.toContain("private");
});
