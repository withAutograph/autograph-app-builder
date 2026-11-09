/* oxlint-disable eslint/require-await, eslint/no-await-in-loop -- Test-owned SDK ports stream the real fixed protocol in frame order. */
/* oxlint-disable typescript/no-non-null-assertion -- Fixture file and journal reads follow successful creation before assertions. */
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createProductionAuthSchemaProposal } from "./production-auth-schema-rollout-proposal";
import { runProductionAuthSchemaFileSpool } from "./hosted-operator-sandbox-launcher";
import { authSchemaRolloutWorkerContext } from "./production-auth-schema-rollout-native";
import { centralHostCanonicalBytes } from "./central-integration-host-contract";
import { receipt as catalogFixture } from "./operator-worker-source-capture.test-fixture";
import {
  owner,
  profile,
  proposal,
  rolloutFixture,
} from "./production-auth-schema-rollout.test-fixture";

const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const json = (value: z.infer<ReturnType<typeof z.json>>) => Buffer.from(JSON.stringify(value));
const migrationUrl =
  "postgresql://auth_owner:private-fixture@ep-auth.neon.tech/auth?sslmode=verify-full";
const fixture = async (
  options: { readOnly?: boolean; effectId?: string; wrongReadback?: boolean } = {},
) => {
  const f = rolloutFixture();
  const { plan } = await f.service.plan(owner, profile.id);
  await f.service.execute(owner, plan.operationRef, plan.planDigest, "approval-call");
  const row = f.rows.get(plan.operationRef)!;
  const catalog = structuredClone(catalogFixture);
  catalog.sources = row.record.runtime.worker.sourceCapture.sources;
  catalog.workers.auth.path = "auth";
  catalog.workers.auth.sha256 = row.record.runtime.worker.sha256;
  catalog.workers.authProposal.path = "authProposal";
  catalog.workers.authProposal.sha256 = row.record.runtime.proposalWorker.sha256;
  const catalogBytes = json(z.json().parse(catalog));
  row.record.runtime.worker.sourceCapture.catalogSha256 = digest(catalogBytes);
  row.record.runtime.proposalWorker.sourceCapture.catalogSha256 = digest(catalogBytes);
  const context = authSchemaRolloutWorkerContext(row);
  const contextDigest = digest(json(z.json().parse(context)));
  const runId = plan.operationRef;
  const root = `/vercel/sandbox/protected-installer/${runId}`;
  const files = new Map<string, Buffer>([["/opt/workers/catalog.json", catalogBytes]]);
  const notices: { stream: "stdout"; data: string }[] = [];
  const ready = (
    area: "lifecycle" | "requests",
    frameId: number,
    value: z.infer<ReturnType<typeof z.json>>,
  ) => {
    files.set(`${root}/${area}/${frameId}.json`, json(value));
    files.set(
      `${root}/${area}/${frameId}.ready`,
      json({ version: 1, run_id: runId, frame_id: frameId }),
    );
    notices.push({
      stream: "stdout",
      data: `${JSON.stringify({ version: 1, kind: area === "lifecycle" ? "protected_installer_lifecycle_ready" : "protected_installer_frame_ready", run_id: runId, frame_id: frameId })}\n`,
    });
  };
  ready("lifecycle", 1, { version: 1, kind: "worker_started", run_id: runId });
  if (options.readOnly !== true || options.effectId !== undefined) {
    const common = {
      version: 1,
      operation_id: runId,
      context_digest: contextDigest,
      fence_generation: context.operation.fence_generation,
      sequence: 1,
      effect_id: options.effectId ?? "auth:apply-schema-plan",
      resource_id: context.resource.resource_id,
      tenant_id: null,
    };
    ready("requests", 1, {
      ...common,
      kind: "authorize_effect",
      approval_digest: plan.planDigest,
      app_id: "auth",
      release_id: context.release.id,
      installer_id: context.installer.id,
      installer_sha256: context.installer.sha256,
    });
    ready("requests", 2, {
      ...common,
      kind: "checkpoint_effect",
      receipt: { state: "applied", readback_sha256: "9".repeat(64) },
    });
  }
  ready("lifecycle", 2, { version: 1, kind: "worker_succeeded", run_id: runId });
  files.set(
    `${root}/readback.json`,
    json({
      version: 1,
      operation_id: options.wrongReadback === true ? "11111111-1111-4111-8111-111111111111" : runId,
      context_digest: contextDigest,
      fence_generation: context.operation.fence_generation,
      status: "applied",
      readback_sha256: "8".repeat(64),
    }),
  );
  const runCommand = vi.fn(async (input: { cmd: string; detached?: boolean; args?: string[] }) => {
    if (input.detached !== true) {
      const reportedDigest =
        input.args?.includes(row.record.runtime.proposalWorker.executablePath) === true
          ? row.record.runtime.proposalWorker.sha256
          : row.record.runtime.worker.sha256;
      return {
        exitCode: 0,
        stdout: async () =>
          input.cmd === row.record.runtime.proposalWorker.executablePath
            ? JSON.stringify(proposal)
            : `${reportedDigest}  worker\n`,
      };
    }
    return {
      async *logs() {
        for (const notice of notices) {
          yield notice;
        }
      },
      wait: async () => ({ exitCode: 0 }),
      kill: async () => {},
    };
  });
  const sandbox = {
    delete: vi.fn(async () => {}),
    extendTimeout: vi.fn(async () => {}),
    runCommand,
    fs: {
      mkdir: async () => {},
      rm: async () => {},
      lstat: async (path: string) => ({
        isFile: () => files.has(path),
        size: files.get(path)?.length ?? 0,
      }),
      readFile: async (path: string) => files.get(path),
    },
    readFileToBuffer: async ({ path }: { path: string }) => files.get(path) ?? null,
    writeFiles: vi.fn(async (entries: { path: string; content: Buffer }[]) => {
      for (const entry of entries) {
        files.set(entry.path, entry.content);
      }
    }),
  };
  // SAFETY: this provider-free fixture implements exactly the SDK methods used by the fixed spool/proposal transports.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Closed fixture supplies the worker-facing Sandbox contract.
  const createSandbox = vi.fn(async () => sandbox as never);
  const checkpoint = vi.fn(async () => {});
  const input = {
    worker: row.record.runtime.worker,
    context,
    operatorPlan: centralHostCanonicalBytes(row.record.operatorPlan),
    authSchemaPlan: centralHostCanonicalBytes(row.record.proposal),
    directDatabaseUrl: migrationUrl,
    readOnly: options.readOnly ?? false,
    runId,
    signal: new AbortController().signal,
    assertCurrent: vi.fn(async () => {}),
    recordCheckpoint: options.readOnly === true ? undefined : checkpoint,
  };
  return { row, files, sandbox, createSandbox, input, checkpoint, runCommand };
};
describe("closed Production Auth schema transport", () => {
  it("executes only schema effect, retains its independent readback checkpoint and isolates credentials", async () => {
    const f = await fixture();
    await runProductionAuthSchemaFileSpool({ ...profile.runtime.sandbox, workers: {} }, f.input, {
      createSandbox: f.createSandbox,
    });
    expect(f.checkpoint).toHaveBeenCalledWith(
      expect.objectContaining({
        effectId: "auth:apply-schema-plan",
        tenantId: null,
        resourceId: profile.resource.resourceId,
        receipt: { state: "applied", readbackSha256: "9".repeat(64) },
      }),
    );
    const invocation = f.runCommand.mock.calls.find(([call]) => call.detached === true)?.[0];
    expect(invocation?.args?.[0]).toBe("auth-protected-schema");
    expect(JSON.stringify(f.runCommand.mock.calls)).not.toContain("private-fixture");
    expect(f.sandbox.delete).toHaveBeenCalledOnce();
  });
  it("runs original-plan reconciliation read-only and accepts only resource-bound readback", async () => {
    const f = await fixture({ readOnly: true });
    const observed = await runProductionAuthSchemaFileSpool(
      { ...profile.runtime.sandbox, workers: {} },
      f.input,
      { createSandbox: f.createSandbox },
    );
    expect(observed).toMatchObject({ status: "applied", readback_sha256: "8".repeat(64) });
    expect(f.checkpoint).not.toHaveBeenCalled();
    expect(f.runCommand.mock.calls.find(([call]) => call.detached === true)?.[0].args?.[0]).toBe(
      "auth-protected-schema-readback",
    );
    const wrong = await fixture({ readOnly: true, wrongReadback: true });
    await expect(
      runProductionAuthSchemaFileSpool({ ...profile.runtime.sandbox, workers: {} }, wrong.input, {
        createSandbox: wrong.createSandbox,
      }),
    ).rejects.toMatchObject({ code: "resource_mismatch" });
  });
  it.each([
    { effectId: "auth:provision-access" },
    { readOnly: true, effectId: "auth:apply-schema-plan" },
  ])(
    "denies membership/ACL provisioning effects and readback mutation requests",
    async (options) => {
      const f = await fixture(options);
      await expect(
        runProductionAuthSchemaFileSpool({ ...profile.runtime.sandbox, workers: {} }, f.input, {
          createSandbox: f.createSandbox,
        }),
      ).rejects.toMatchObject({ code: "resource_mismatch" });
      expect(f.checkpoint).not.toHaveBeenCalled();
    },
  );
  it.each(["resource", "worker", "approval", "credential"])(
    "rejects changed %s before creating a VM",
    async (kind) => {
      const f = await fixture();
      if (kind === "resource") {
        f.input.context.resource.database = "other";
      } else if (kind === "worker") {
        f.input.context.installer.id = "auth-owned-organization-v1";
      } else if (kind === "approval") {
        f.input.operatorPlan = Buffer.from("{}");
      } else {
        f.input.directDatabaseUrl = migrationUrl.replace("auth_owner", "auth_operator");
      }
      await expect(
        runProductionAuthSchemaFileSpool({ ...profile.runtime.sandbox, workers: {} }, f.input, {
          createSandbox: f.createSandbox,
        }),
      ).rejects.toMatchObject({ code: "resource_mismatch" });
      expect(f.createSandbox).not.toHaveBeenCalled();
    },
  );
  it("Production proposal passes an explicit restricted operator role through a private file", async () => {
    const f = await fixture();
    const selected = { ...profile, runtime: f.row.record.runtime };
    const readMigrationUrl = vi.fn(async () => migrationUrl);
    const result = await createProductionAuthSchemaProposal({
      createSandbox: f.createSandbox,
      getOidc: async () => "test-oidc",
    })({ profile: selected, readMigrationUrl, assertCurrent: async () => {} });
    expect(result).toEqual(proposal);
    const input = f.files.get("/vercel/sandbox/auth-schema-proposal-input.json");
    expect(JSON.parse(input!.toString("utf-8"))).toMatchObject({
      authOperatorRole: profile.authOperatorRole,
      resource: { environment: "production" },
    });
    expect(input!.toString("utf-8")).not.toContain("private-fixture");
    expect(JSON.stringify(f.runCommand.mock.calls)).not.toContain("private-fixture");
  });
  it("does not mark dispatch on failed VM creation, and marks it before an uncertain worker command", async () => {
    const f = await fixture();
    const beforeWorkerDispatch = vi.fn(async () => {});
    await expect(
      runProductionAuthSchemaFileSpool(
        { ...profile.runtime.sandbox, workers: {} },
        { ...f.input, beforeWorkerDispatch },
        {
          createSandbox: async () => {
            throw new Error("VM unavailable");
          },
        },
      ),
    ).rejects.toThrow();
    expect(beforeWorkerDispatch).not.toHaveBeenCalled();
    const original = f.runCommand.getMockImplementation();
    f.runCommand.mockImplementation(async (command) => {
      if (command.detached === true) {
        expect(beforeWorkerDispatch).toHaveBeenCalledOnce();
        throw new Error("command dispatch response lost");
      }
      if (original === undefined) {
        throw new Error("Fixture command missing");
      }
      return await original(command);
    });
    await expect(
      runProductionAuthSchemaFileSpool(
        { ...profile.runtime.sandbox, workers: {} },
        { ...f.input, beforeWorkerDispatch },
        { createSandbox: f.createSandbox },
      ),
    ).rejects.toThrow();
    expect(beforeWorkerDispatch).toHaveBeenCalledOnce();
  });
});
