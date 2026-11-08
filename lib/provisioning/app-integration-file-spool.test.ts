/* oxlint-disable eslint/require-await, typescript/no-unsafe-type-assertion, anti-slop/no-chained-type-assertions -- Minimal official SDK fake exercises real transport without allocating compute. */
import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { runAppIntegrationFileSpool } from "./hosted-operator-sandbox-launcher";
import type { ProtectedInstallContextWire } from "./hosted-operator-sandbox-launcher";

const runId = "11111111-1111-4111-a111-111111111111";
const sha = "a".repeat(64);
const worker = {
  id: "app-integration-bootstrap-v1",
  sha256: sha,
  operationScope: "app-integration-bootstrap-v1",
  executablePath: "/worker/integration",
  subcommand: "integration-control-schema-readback",
} as const;
const context: ProtectedInstallContextWire = {
  version: 1,
  operation: { operation_id: runId, approval_digest: "b".repeat(64), fence_generation: 7 },
  app_id: "invoice-app",
  resource: {
    resource_id: "isolated-control",
    environment: "preview",
    hostname: "ep-control.neon.tech",
    port: 5432,
    database: "integrations",
    schema: "public",
    migrator_role: "control_owner",
    runtime_role: "app_lease",
    provider_project_id: "isolated-project",
    provider_branch_id: "isolated-branch",
  },
  release: { id: "checked-release", sha256: "c".repeat(64) },
  installer: { id: worker.id, sha256: sha },
  tenant_targets: ["one-tenant"],
};
const digest = createHash("sha256").update(JSON.stringify(context)).digest("hex");
const removalReceipt = (status: "unknown" | "not-applied" | "applied") =>
  status === "applied"
    ? {
        receipt: {
          operationRef: runId,
          active: false as const,
          principalGeneration: 8,
          priorGeneration: 7,
          stoppedBindingsSha256: sha,
        },
        readback_sha256: sha,
      }
    : {};
const fixture = (
  mutation = false,
  removal = false,
  removalStatus?: "unknown" | "not-applied" | "applied",
) => {
  const files = new Map<string, Buffer>();
  const stop = vi.fn(async () => {});
  const frame = (path: string, data: z.infer<ReturnType<typeof z.json>>) =>
    files.set(path, Buffer.from(JSON.stringify(data)));
  const sandbox = {
    fs: {
      mkdir: vi.fn(async () => {}),
      rm: vi.fn(async () => {}),
      lstat: vi.fn(async (path: string) => ({
        isFile: () => true,
        size: files.get(path)?.length ?? 0,
      })),
    },
    writeFiles: vi.fn(async (rows: { path: string; content: Buffer }[]) => {
      for (const row of rows) {
        files.set(row.path, row.content);
      }
    }),
    readFileToBuffer: vi.fn(async ({ path }: { path: string }) => files.get(path) ?? null),
    delete: stop,
    extendTimeout: vi.fn(async () => {}),
    runCommand: vi.fn(async (options: { detached?: boolean; args: string[] }) => {
      if (options.detached !== true) {
        return { exitCode: 0, stdout: async () => `${sha}  /worker/integration\n` };
      }
      const spool = options.args[2];
      frame(`${spool}/requests/1.json`, {
        kind: mutation ? "authorize_effect" : "check_fence",
        version: 1,
        operation_id: runId,
        approval_digest: context.operation.approval_digest,
        context_digest: digest,
        fence_generation: 7,
        app_id: context.app_id,
        resource_id: context.resource.resource_id,
        release_id: context.release.id,
        installer_id: worker.id,
        installer_sha256: sha,
        tenant_id: null,
        ...(mutation ? { effect_id: "install-control-schema", sequence: 1 } : {}),
      });
      frame(`${spool}/requests/1.ready`, { version: 1, run_id: runId, frame_id: 1 });
      if (removal) {
        const base = z.record(z.string(), z.unknown()).parse(
          JSON.parse(
            z
              .instanceof(Buffer)
              .parse(files.get(`${spool}/requests/1.json`))
              .toString("utf-8"),
          ),
        );
        for (const [frameId, kind] of [
          [2, "authorize_effect"],
          [3, "check_fence"],
          [4, "checkpoint_effect"],
        ] as const) {
          frame(`${spool}/requests/${frameId}.json`, {
            ...base,
            kind,
            ...(kind === "check_fence"
              ? {}
              : { sequence: 1, effect_id: "fence-app-integration-authority" }),
            ...(kind === "checkpoint_effect"
              ? { receipt: { state: "applied", readback_sha256: "d".repeat(64) } }
              : {}),
          });
          if (kind === "checkpoint_effect") {
            frame(`${spool}/requests/${frameId}.json`, {
              kind,
              version: 1,
              operation_id: runId,
              context_digest: digest,
              fence_generation: 7,
              sequence: 1,
              effect_id: "fence-app-integration-authority",
              resource_id: context.resource.resource_id,
              tenant_id: null,
              receipt: { state: "applied", readback_sha256: "d".repeat(64) },
            });
          }
          frame(`${spool}/requests/${frameId}.ready`, {
            version: 1,
            run_id: runId,
            frame_id: frameId,
          });
        }
      }

      for (const [index, kind] of [
        [1, "worker_started"],
        [2, "worker_succeeded"],
      ] as const) {
        frame(`${spool}/lifecycle/${index}.json`, { version: 1, run_id: runId, kind });
        frame(`${spool}/lifecycle/${index}.ready`, { version: 1, run_id: runId, frame_id: index });
      }
      frame(`${spool}/readback.json`, {
        version: 1,
        operation_id: runId,
        context_digest: digest,
        fence_generation: 7,
        status: "applied",
        readback_sha256: "d".repeat(64),
        receipt: { resourceId: context.resource.resource_id, schemaSha256: "e".repeat(64) },
      });
      if (removalStatus !== undefined) {
        frame(
          `${spool}/readback.json`,
          z.json().parse({
            version: 1,
            operation_id: runId,
            context_digest: digest,
            fence_generation: 7,
            status: removalStatus,
            ...removalReceipt(removalStatus),
          }),
        );
      }
      return {
        kill: vi.fn(async () => {}),
        wait: async () => ({ exitCode: 0 }),
        logs: async function* logs() {
          for (const [kind, frameId] of [
            ["protected_installer_lifecycle_ready", 1],
            ["protected_installer_frame_ready", 1],
            ...(removal
              ? ([
                  ["protected_installer_frame_ready", 2],
                  ["protected_installer_frame_ready", 3],
                  ["protected_installer_frame_ready", 4],
                ] as const)
              : []),
            ["protected_installer_lifecycle_ready", 2],
          ] as const) {
            yield {
              stream: "stdout",
              data: `${JSON.stringify({ kind, version: 1, run_id: runId, frame_id: frameId })}\n`,
            };
          }
        },
      };
    }),
  };
  const createSandbox = vi.fn(async () => sandbox);
  const input = {
    worker,
    context,
    runId,
    directDatabaseUrl:
      "postgresql://owner:private@ep-control.neon.tech/integrations?sslmode=verify-full",
    startupFiles: { "app-integration-approved-plan.json": Buffer.from("{}") },
    readOnly: true,
    signal: new AbortController().signal,
    assertCurrent: vi.fn(async () => {}),
  };
  return { input, createSandbox, stop, files };
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
  const result = await runAppIntegrationFileSpool(config, f.input, {
    createSandbox: f.createSandbox as unknown as NonNullable<
      Parameters<typeof runAppIntegrationFileSpool>[2]
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
      `/vercel/sandbox/protected-installer/${runId}/startup/app-integration-approved-plan.json`,
    ),
  ).toBe(true);
});
it("denies mutation frames in a read-only integration worker", async () => {
  const f = fixture(true);
  // SAFETY: Same bounded SDK fake as the successful readback case.
  await expect(
    runAppIntegrationFileSpool(config, f.input, {
      createSandbox: f.createSandbox as unknown as NonNullable<
        Parameters<typeof runAppIntegrationFileSpool>[2]
      >["createSandbox"],
    }),
  ).rejects.toThrow();
  expect(f.stop).toHaveBeenCalledOnce();
});
it("rejects a foreign worker before allocation", async () => {
  const f = fixture();
  await expect(
    runAppIntegrationFileSpool(config, { ...f.input, worker: { ...worker, id: "other-worker" } }),
  ).rejects.toThrow();
  expect(f.createSandbox).not.toHaveBeenCalled();
});

it("authorizes the stopped snapshot only at the app fence frame, not narrow owner polls, then ACKs its receipt", async () => {
  const f = fixture(false, true);
  const authorize = vi.fn(async () => {});
  const checkpoint = vi.fn(async () => {});
  await runAppIntegrationFileSpool(
    config,
    {
      ...f.input,
      readOnly: false,
      worker: { ...worker, subcommand: "integration-fence-app-authority" },
      authorizeAppIntegrationRemoval: authorize,
      recordCheckpoint: checkpoint,
    },
    {
      // SAFETY: Same bounded official-SDK transport fake as existing protocol tests.
      createSandbox: f.createSandbox as unknown as NonNullable<
        Parameters<typeof runAppIntegrationFileSpool>[2]
      >["createSandbox"],
    },
  );
  expect(authorize).toHaveBeenCalledOnce();
  expect(checkpoint).toHaveBeenCalledOnce();
  expect(f.input.assertCurrent.mock.calls.length).toBeGreaterThan(2);
  expect(checkpoint).toHaveBeenCalledWith(
    expect.objectContaining({
      effectId: "fence-app-integration-authority",
      receipt: { readbackSha256: "d".repeat(64), state: "applied" },
    }),
  );
});
it("rejects a missing stopped-authority callback before allocating an app fence worker", async () => {
  const f = fixture();
  await expect(
    runAppIntegrationFileSpool(config, {
      ...f.input,
      readOnly: false,
      worker: { ...worker, subcommand: "integration-fence-app-authority" },
    }),
  ).rejects.toThrow();
  expect(f.createSandbox).not.toHaveBeenCalled();
});

it.each(["unknown", "not-applied", "applied"] as const)(
  "reads closed removal %s status through the actual transport",
  async (status) => {
    const f = fixture(false, false, status);
    const result = await runAppIntegrationFileSpool(
      config,
      {
        ...f.input,
        worker: { ...worker, subcommand: "integration-fence-app-authority-readback" },
      },
      {
        // SAFETY: Same minimal official SDK fake exercises actual framed parsing, not allocation.
        createSandbox: f.createSandbox as unknown as NonNullable<
          Parameters<typeof runAppIntegrationFileSpool>[2]
        >["createSandbox"],
      },
    );
    expect(result).toMatchObject({ status });
    expect(f.stop).toHaveBeenCalledOnce();
  },
);
