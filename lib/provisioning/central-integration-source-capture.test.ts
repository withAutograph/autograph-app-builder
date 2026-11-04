/* oxlint-disable eslint/require-await -- Controlled native transport retains its actual asynchronous contract. */
import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { plan as original } from "./central-integration-host-test-fixture";
import { centralHostCanonicalBytes } from "./central-integration-host-contract";
import { createCentralIntegrationSourceCapture } from "./central-integration-source-capture";
import type { runCentralIntegrationFileSpool } from "./hosted-operator-sandbox-launcher";

const hash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const profile = "isolated-central-integrations-v1";
const fixture = () => {
  const plan = {
    ...structuredClone(original),
    source: {
      ...original.source,
      serviceIds: ["gateway", "integrations"],
      buildReceiptSha256: "e".repeat(64),
    },
    environment: [
      ...original.environment.filter((entry) => entry.key !== "AUTOGRAPH_DEPLOYMENT_PROFILE"),
      { key: "AUTOGRAPH_DEPLOYMENT_PROFILE", sha256: hash(profile) },
    ],
  };
  const configuration = {
    image: "owned-test-worker-filesystem",
    projectId: "operator-project",
    teamId: "operator-team",
    workers: {},
    centralIntegrationWorker: {
      ...plan.source.workers.schema,
      operationScope: "central-integration-bootstrap-v1" as const,
      executablePath: "/worker/central",
      subcommand: "central-integration-schema" as const,
    },
  };
  const receipt = {
    sourceSha: plan.source.reviewedSourceSha,
    deploymentProfile: profile,
    serviceIds: ["gateway", "integrations"],
    servicesManifestSha256: plan.source.servicesManifestSha256,
    workers: plan.source.workers,
  };
  const output = {
    version: 1 as const,
    operation_id: "11111111-1111-4111-a111-111111111111",
    context_digest: "f".repeat(64),
    fence_generation: 1,
    status: "applied" as const,
    receipt,
    readback_sha256: hash(centralHostCanonicalBytes(z.json().parse(receipt))),
  };
  const cancellation = new AbortController();
  const context = {
    plan,
    invocation: {
      authority: plan.authority,
      sessionId: plan.selection.sessionId,
      callId: "actual-read-call",
      signal: cancellation.signal,
    },
    assertCurrent: vi.fn(async () => {}),
  };
  const run = vi.fn<typeof runCentralIntegrationFileSpool>(async () => output);
  return { plan, configuration, receipt, output, context, run, cancellation };
};

it("captures the exact frozen source graph with a database-free read-only invocation", async () => {
  const f = fixture();
  const read = createCentralIntegrationSourceCapture(f);
  expect(await read(f.context)).toEqual(f.receipt);
  const sent = f.run.mock.calls[0]?.[1];
  expect(sent).toMatchObject({
    readOnly: true,
    worker: { subcommand: "central-integration-source-capture" },
    context: {
      kind: "central_source_capture",
      source: { build_receipt_sha256: f.plan.source.buildReceiptSha256 },
      release: {
        id: f.plan.source.reviewedSourceSha,
        sha256: f.plan.source.buildReceiptSha256,
      },
    },
  });
  expect(sent).not.toHaveProperty("directDatabaseUrl");
  expect(sent).not.toHaveProperty("recordCheckpoint");
  expect(Object.keys(sent?.startupFiles ?? {})).toEqual(["central-integration-approved-plan.json"]);
  expect(f.context.assertCurrent).toHaveBeenCalled();
});

it("does not allocate inspection compute for a foreign caller or unreviewed graph/profile", async () => {
  const f = fixture();
  const read = createCentralIntegrationSourceCapture(f);
  await expect(
    read({
      ...f.context,
      invocation: { ...f.context.invocation, sessionId: "foreign" },
    }),
  ).rejects.toThrow();
  await expect(
    read({
      ...f.context,
      plan: {
        ...f.plan,
        source: { ...f.plan.source, serviceIds: ["gateway", "apps", "integrations"] },
      },
    }),
  ).rejects.toThrow();
  await expect(
    read({
      ...f.context,
      plan: {
        ...f.plan,
        environment: f.plan.environment.filter((x) => x.key !== "AUTOGRAPH_DEPLOYMENT_PROFILE"),
      },
    }),
  ).rejects.toThrow();
  await expect(
    read({
      ...f.context,
      plan: { ...f.plan, source: { ...f.plan.source, buildReceiptSha256: undefined } },
    }),
  ).rejects.toThrow();
  expect(f.run).not.toHaveBeenCalled();
});

it("rejects a mismatched pinned worker before inspection", async () => {
  const f = fixture();
  const read = createCentralIntegrationSourceCapture({
    ...f,
    configuration: {
      ...f.configuration,
      centralIntegrationWorker: {
        ...f.configuration.centralIntegrationWorker,
        sha256: "0".repeat(64),
      },
    },
  });
  await expect(read(f.context)).rejects.toThrow();
  expect(f.run).not.toHaveBeenCalled();
});

it("rejects actual observation drift and a changed receipt checksum", async () => {
  const f = fixture();
  const read = createCentralIntegrationSourceCapture(f);
  const changed = { ...f.output, receipt: { ...f.receipt, sourceSha: "0".repeat(40) } };
  f.run.mockResolvedValueOnce(changed);
  await expect(read(f.context)).rejects.toThrow();
  f.run.mockResolvedValueOnce({ ...f.output, readback_sha256: "0".repeat(64) });
  await expect(read(f.context)).rejects.toThrow();
});

it("rechecks owner/cancellation after readback without creating any receipt or fallback", async () => {
  const f = fixture();
  f.run.mockImplementationOnce(async () => {
    f.cancellation.abort();
    return f.output;
  });
  await expect(createCentralIntegrationSourceCapture(f)(f.context)).rejects.toThrow();
  expect(f.run).toHaveBeenCalledTimes(1);
});
