/* oxlint-disable eslint/require-await, typescript/no-unsafe-type-assertion -- Minimal official SDK fake exercises real transport without allocating compute. */
import { centralHostCanonicalBytes } from "./central-integration-host-contract";
import { z } from "zod";
import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { runCentralIntegrationFileSpool } from "./hosted-operator-sandbox-launcher";
import type {
  CentralIntegrationContextWire,
  CentralSourceCaptureContextWire,
} from "./hosted-operator-sandbox-launcher";

const runId = "11111111-1111-4111-a111-111111111111";
const sha = "a".repeat(64);
const worker = {
  executablePath: "/worker/integration",
  id: "central-integration-bootstrap-v1",
  operationScope: "central-integration-bootstrap-v1",
  sha256: sha,
  subcommand: "central-integration-schema-readback",
} as const;
const context: CentralIntegrationContextWire = {
  app_id: "integrations",
  installer: { id: worker.id, sha256: sha },
  kind: "central_integration_schema",
  operation: { approval_digest: "b".repeat(64), fence_generation: 7, operation_id: runId },
  release: { id: "checked-release", sha256: "c".repeat(64) },
  resource: {
    database: "integrations",
    environment: "preview",
    hostname: "ep-control.neon.tech",
    migrator_role: "control_owner",
    port: 5432,
    provider_branch_id: "isolated-branch",
    provider_endpoint_id: "isolated-endpoint",
    provider_project_id: "isolated-project",
    resource_id: "isolated-control",
    runtime_role: "app_lease",
    schema: "public",
  },
  tenant_targets: [],
  version: 1,
};
const fixture = (mutation = false, write = false, capture = false) => {
  const wire: CentralIntegrationContextWire | CentralSourceCaptureContextWire = capture
    ? {
        ...context,
        kind: "central_source_capture",
        operation: { ...context.operation, fence_generation: 1 },
        source: {
          build_receipt_sha256: "c".repeat(64),
          deployment_profile: "isolated-central-integrations-v1",
          repository_id: "source-repository",
          reviewed_source_sha: "a".repeat(40),
          services_manifest_sha256: "b".repeat(64),
        },
      }
    : context;
  const digest = createHash("sha256")
    .update(centralHostCanonicalBytes(z.json().parse(wire)))
    .digest("hex");
  const files = new Map<string, Buffer>();
  const stop = vi.fn(async () => {});
  const frame = (path: string, data: z.infer<ReturnType<typeof z.json>>) =>
    files.set(path, Buffer.from(JSON.stringify(data)));
  const sandbox = {
    delete: stop,
    extendTimeout: vi.fn(async () => {}),
    fs: {
      lstat: vi.fn(async (path: string) => ({
        isFile: () => true,
        size: files.get(path)?.length ?? 0,
      })),
      mkdir: vi.fn(async () => {}),
      rm: vi.fn(async () => {}),
    },
    readFileToBuffer: vi.fn(async ({ path }: { path: string }) => files.get(path) ?? null),
    runCommand: vi.fn(async (options: { detached?: boolean; args: string[] }) => {
      if (options.detached !== true) {
        return { exitCode: 0, stdout: async () => `${sha}  /worker/integration\n` };
      }
      const spool = options.args[2];
      frame(`${spool}/requests/1.json`, {
        app_id: wire.app_id,
        approval_digest: wire.operation.approval_digest,
        context_digest: digest,
        fence_generation: wire.operation.fence_generation,
        installer_id: worker.id,
        installer_sha256: sha,
        kind: mutation ? "authorize_effect" : "check_fence",
        operation_id: runId,
        release_id: wire.release.id,
        resource_id: wire.resource.resource_id,
        tenant_id: null,
        version: 1,
        ...(mutation ? { effect_id: "install-central-schema", sequence: 1 } : {}),
      });
      frame(`${spool}/requests/1.ready`, { frame_id: 1, run_id: runId, version: 1 });
      if (write) {
        frame(`${spool}/requests/2.json`, {
          context_digest: digest,
          effect_id: "install-central-schema",
          fence_generation: wire.operation.fence_generation,
          kind: "checkpoint_effect",
          operation_id: runId,
          receipt: { readback_sha256: "d".repeat(64), state: "applied" },
          resource_id: wire.resource.resource_id,
          sequence: 1,
          tenant_id: null,
          version: 1,
        });
        frame(`${spool}/requests/2.ready`, { frame_id: 2, run_id: runId, version: 1 });
      }
      for (const [index, kind] of [
        [1, "worker_started"],
        [2, "worker_succeeded"],
      ] as const) {
        frame(`${spool}/lifecycle/${index}.json`, { kind, run_id: runId, version: 1 });
        frame(`${spool}/lifecycle/${index}.ready`, { frame_id: index, run_id: runId, version: 1 });
      }
      frame(`${spool}/readback.json`, {
        context_digest: digest,
        fence_generation: wire.operation.fence_generation,
        operation_id: runId,
        readback_sha256: "d".repeat(64),
        receipt: { resourceId: wire.resource.resource_id, schemaSha256: "e".repeat(64) },
        status: "applied",
        version: 1,
      });
      return {
        kill: vi.fn(async () => {}),
        async *logs() {
          for (const [kind, frameId] of [
            ["protected_installer_lifecycle_ready", 1],
            ["protected_installer_frame_ready", 1],
            ...(write ? [["protected_installer_frame_ready", 2] as const] : []),
            ["protected_installer_lifecycle_ready", 2],
          ] as const) {
            yield {
              data: `${JSON.stringify({ frame_id: frameId, kind, run_id: runId, version: 1 })}\n`,
              stream: "stdout",
            };
          }
        },
        wait: async () => ({ exitCode: 0 }),
      };
    }),
    writeFiles: vi.fn(async (rows: { path: string; content: Buffer }[]) => {
      for (const row of rows) {
        files.set(row.path, row.content);
      }
    }),
  };
  const createSandbox: unknown = vi.fn(async () => sandbox);
  const input = {
    worker: capture
      ? { ...worker, subcommand: "central-integration-source-capture" as const }
      : worker,
    context: wire,
    runId,
    ...(capture
      ? {}
      : {
          directDatabaseUrl:
            "postgresql://owner:private@ep-control.neon.tech/integrations?sslmode=verify-full",
        }),
    startupFiles: { "central-integration-approved-plan.json": Buffer.from("{}") },
    readOnly: true,
    signal: new AbortController().signal,
    assertCurrent: vi.fn(async () => {}),
  };
  return { createSandbox, files, input, stop };
};
const config = {
  image: "pinned-control",
  projectId: "operator-project",
  teamId: "owned-team",
  workers: {},
};
it("reuses the fenced framed transport for fixed integration readback and private startup files", async () => {
  const f = fixture();
  // SAFETY: The fake implements only the SDK methods consumed by the transport.
  const result = await runCentralIntegrationFileSpool(config, f.input, {
    createSandbox: f.createSandbox as NonNullable<
      Parameters<typeof runCentralIntegrationFileSpool>[2]
    >["createSandbox"],
  });
  expect(result).toMatchObject({
    receipt: { resourceId: context.resource.resource_id },
    status: "applied",
  });
  expect(f.input.assertCurrent).toHaveBeenCalled();
  expect(f.stop).toHaveBeenCalledOnce();
  expect(
    f.files.has(
      `/vercel/sandbox/protected-installer/${runId}/startup/central-integration-approved-plan.json`,
    ),
  ).toBe(true);
});
it("denies mutation frames in a read-only integration worker", async () => {
  const f = fixture(true);
  // SAFETY: Same bounded SDK fake as the successful readback case.
  await expect(
    runCentralIntegrationFileSpool(config, f.input, {
      createSandbox: f.createSandbox as NonNullable<
        Parameters<typeof runCentralIntegrationFileSpool>[2]
      >["createSandbox"],
    }),
  ).rejects.toThrow();
  expect(f.stop).toHaveBeenCalledOnce();
});
it("rejects a foreign worker before allocation", async () => {
  const f = fixture();
  await expect(
    runCentralIntegrationFileSpool(config, {
      ...f.input,
      worker: { ...worker, id: "other-worker" },
    }),
  ).rejects.toThrow();
  expect(f.createSandbox).not.toHaveBeenCalled();
});

it("records the fixed global schema checkpoint before acknowledging its write", async () => {
  const f = fixture(true, true);
  const recordCheckpoint = vi.fn(async () => {
    expect(f.files.has(`/vercel/sandbox/protected-installer/${runId}/responses/2.json`)).toBe(
      false,
    );
  });
  // SAFETY: This bounded SDK fixture implements the methods used by the real transport; it allocates no compute.
  await runCentralIntegrationFileSpool(
    config,
    {
      ...f.input,
      readOnly: false,
      recordCheckpoint,
      worker: { ...worker, subcommand: "central-integration-schema" },
    },
    {
      createSandbox: f.createSandbox as NonNullable<
        Parameters<typeof runCentralIntegrationFileSpool>[2]
      >["createSandbox"],
    },
  );
  expect(recordCheckpoint).toHaveBeenCalledOnce();
  expect(f.files.has(`/vercel/sandbox/protected-installer/${runId}/responses/2.json`)).toBe(true);
  expect(f.stop).toHaveBeenCalledOnce();
});

it("runs source capture with no database or credential file and rejects mutation requests", async () => {
  const f = fixture(false, false, true);
  // SAFETY: The bounded official-SDK fake executes the actual framed protocol without creating provider resources.
  await runCentralIntegrationFileSpool(config, f.input, {
    createSandbox: f.createSandbox as NonNullable<
      Parameters<typeof runCentralIntegrationFileSpool>[2]
    >["createSandbox"],
  });

  expect(
    [...f.files.keys()].some(
      (p) =>
        p.endsWith("/direct-database-url.json") ||
        p.endsWith("/central-integration-connections.json"),
    ),
  ).toBe(false);
  const bad = fixture(true, false, true);
  // SAFETY: Same bounded official-SDK fixture verifies fail-closed read-only authorization.
  await expect(
    runCentralIntegrationFileSpool(config, bad.input, {
      createSandbox: bad.createSandbox as NonNullable<
        Parameters<typeof runCentralIntegrationFileSpool>[2]
      >["createSandbox"],
    }),
  ).rejects.toThrow();
  expect(bad.stop).toHaveBeenCalledOnce();
});

it("rejects source-capture database credentials and execute mode before allocating compute", async () => {
  const f = fixture(false, false, true);
  await expect(
    runCentralIntegrationFileSpool(config, { ...f.input, readOnly: false }),
  ).rejects.toThrow();
  await expect(
    runCentralIntegrationFileSpool(config, {
      ...f.input,
      directDatabaseUrl: "postgresql://owner:private@ep-control.neon.tech/integrations",
    }),
  ).rejects.toThrow();
  await expect(
    runCentralIntegrationFileSpool(config, {
      ...f.input,
      startupFiles: { "central-integration-connections.json": Buffer.from("{}") },
    }),
  ).rejects.toThrow();
  expect(f.createSandbox).not.toHaveBeenCalled();
});
