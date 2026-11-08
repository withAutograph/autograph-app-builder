/* oxlint-disable eslint/require-await -- Synthetic transport ports preserve asynchronous failures without provider effects. */
import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { runRepositoryProductionFileSpool } from "./hosted-operator-sandbox-launcher";
import { HostedOperatorError } from "./hosted-operator-contract";
import { capture, receipt } from "./operator-worker-source-capture.test-fixture";
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
const input = () => {
  const startupFiles = {};
  const { signal } = new AbortController();
  const assertCurrent = vi.fn(async () => {});
  const recordCheckpoint = vi.fn(async () => {});
  return {
    assertCurrent,
    context,
    directDatabaseUrl:
      "postgresql://maintenance:private-fixture-password@ep-fixture.neon.tech/neondb",
    operation: "storage" as const,
    readOnly: false,
    recordCheckpoint,
    resourceCredentialBytes: privateCredentials,
    runId,
    signal,
    startupFiles,
    worker,
  };
};
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

const pinnedTransport = (pinMatches = true) => {
  const catalog = structuredClone(receipt);
  catalog.workers.resources = {
    ...catalog.workers.resources,
    path: "resource",
    sha256: worker.sha256,
  };
  const catalogBytes = Buffer.from(JSON.stringify(catalog));
  const request = input();
  request.worker = {
    ...worker,
    sourceCapture: {
      ...capture,
      catalogPath: "/worker/catalog.json",
      catalogSha256: createHash("sha256").update(catalogBytes).digest("hex"),
      family: "resources",
    },
  };
  let catalogRead = false;
  const command = {
    kill: vi.fn(async () => {}),
    async *logs() {
      yield { stream: "stdout", data: "private protocol body\n" };
    },
    wait: vi.fn(async () => ({ exitCode: 0 })),
  };
  const sandbox = {
    delete: vi.fn(async () => {}),
    extendTimeout: vi.fn(async () => {}),
    fs: {
      mkdir: vi.fn(async () => {}),
      readFile: vi.fn(async () => {
        catalogRead = true;
        return catalogBytes;
      }),
      rm: vi.fn(async () => {}),
    },
    runCommand: vi.fn(async ({ detached }: { detached?: boolean }) =>
      detached
        ? command
        : {
            exitCode: 0,
            stdout: async () =>
              `${pinMatches ? worker.sha256 : "0".repeat(64)}  /worker/resource\n`,
          },
    ),
    writeFiles: vi.fn(async () => {}),
  };
  // SAFETY: The real transport consumes only these controlled SDK filesystem/process ports.
  const createSandbox = vi.fn(async () => sandbox as never);
  return { catalogRead: () => catalogRead, command, createSandbox, request, sandbox };
};

it("retains the actual pin-refusal stage after deleting the owned Sandbox", async () => {
  const log = vi.spyOn(console, "warn").mockImplementation(() => {});
  const f = pinnedTransport(false);
  await expect(
    runRepositoryProductionFileSpool(configuration, f.request, {
      createSandbox: f.createSandbox,
    }),
  ).rejects.toMatchObject({ code: "resource_mismatch" });
  expect(f.sandbox.delete).toHaveBeenCalledOnce();
  expect(f.sandbox.writeFiles).not.toHaveBeenCalled();
  expect(f.request.recordCheckpoint).not.toHaveBeenCalled();
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- Keep parsed diagnostic JSON unknown until the test inspects it.
  const events = log.mock.calls.map(([entry]): unknown => JSON.parse(String(entry)));
  expect(events).toContainEqual(
    expect.objectContaining({
      launcherStage: "worker_pin",
      operatorCode: "resource_mismatch",
      requestAborted: false,
    }),
  );
  const output = JSON.stringify(log.mock.calls);
  expect(output).not.toContain(f.request.directDatabaseUrl);
  expect(output).not.toContain(context.resource.database);
  expect(output).not.toContain(f.request.worker.executablePath);
  expect(output).not.toContain(privateCredentials.toString());
});

it("reports a real protocol rejection without exposing the malformed worker output", async () => {
  const log = vi.spyOn(console, "warn").mockImplementation(() => {});
  const f = pinnedTransport();
  await expect(
    runRepositoryProductionFileSpool(configuration, f.request, {
      createSandbox: f.createSandbox,
    }),
  ).rejects.toMatchObject({ code: "resource_mismatch" });
  expect(f.command.kill).toHaveBeenCalledOnce();
  expect(f.sandbox.delete).toHaveBeenCalledOnce();
  expect(f.request.recordCheckpoint).not.toHaveBeenCalled();
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- Keep parsed diagnostic JSON unknown until the test inspects it.
  const events = log.mock.calls.map(([entry]): unknown => JSON.parse(String(entry)));
  expect(events).toContainEqual(expect.objectContaining({ launcherStage: "worker_protocol" }));
  const output = JSON.stringify(log.mock.calls);
  expect(output).not.toContain("private protocol body");
  expect(output).not.toContain("postgresql:");
  expect(output).not.toContain(context.resource.database);
  expect(output).not.toContain(privateCredentials.toString());
});

it("preserves late authority rejection, cancellation and cleanup even when logging fails", async () => {
  const log = vi.spyOn(console, "warn").mockImplementation(() => {});
  const f = pinnedTransport();
  const controller = new AbortController();
  f.request.signal = controller.signal;
  const original = new HostedOperatorError("authorization_required", {
    cause: new Error("private authority cause"),
  });
  f.request.assertCurrent.mockImplementation(async () => {
    if (f.catalogRead()) {
      controller.abort();
      throw original;
    }
  });
  await expect(
    runRepositoryProductionFileSpool(configuration, f.request, {
      createSandbox: f.createSandbox,
    }),
  ).rejects.toBe(original);
  expect(f.sandbox.delete).toHaveBeenCalledOnce();
  expect(f.request.recordCheckpoint).not.toHaveBeenCalled();
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- Keep parsed diagnostic JSON unknown until the test inspects it.
  const events = log.mock.calls.map(([entry]): unknown => JSON.parse(String(entry)));
  expect(events).toContainEqual(
    expect.objectContaining({ launcherStage: "spool_setup", requestAborted: true }),
  );
  expect(JSON.stringify(log.mock.calls)).not.toContain("private authority cause");
  log.mockImplementation(() => {
    throw new Error("observer unavailable");
  });
  const retry = pinnedTransport();
  retry.request.assertCurrent.mockImplementation(async () => {
    if (retry.catalogRead()) {
      throw original;
    }
  });
  await expect(
    runRepositoryProductionFileSpool(configuration, retry.request, {
      createSandbox: retry.createSandbox,
    }),
  ).rejects.toBe(original);
  expect(retry.sandbox.delete).toHaveBeenCalledOnce();
});
