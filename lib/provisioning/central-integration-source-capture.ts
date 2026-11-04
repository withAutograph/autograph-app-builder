import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  centralHostCanonicalBytes,
  centralHostOperationRef,
  centralHostPlanDigest,
} from "./central-integration-host-contract";
import type { CentralHostSetupPlan } from "./central-integration-host-contract";
import type { PublicReleaseInvocation } from "./public-release-handler";
import { runCentralIntegrationFileSpool } from "./hosted-operator-sandbox-launcher";
import type {
  CentralSourceCaptureContextWire,
  HostedOperatorSandboxConfiguration,
} from "./hosted-operator-sandbox-launcher";

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const profile = "isolated-central-integrations-v1";
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
export const centralIntegrationSourceCaptureSchema = z.strictObject({
  sourceSha: z.string().regex(/^[a-f0-9]{40}$/u),
  deploymentProfile: z.literal(profile),
  serviceIds: z.tuple([z.literal("gateway"), z.literal("integrations")]),
  servicesManifestSha256: digest,
  workers: z.strictObject({
    resources: z.strictObject({ id: z.literal("neon-resource-bootstrap-v1"), sha256: digest }),
    schema: z.strictObject({ id: z.literal("central-integration-bootstrap-v1"), sha256: digest }),
  }),
});
const unavailable = () => new Error("central_source_capture_unavailable");

/** Read-only source proof; it cannot authorize an installer or settle a provider effect. */
export const createCentralIntegrationSourceCapture =
  (input: {
    configuration: HostedOperatorSandboxConfiguration;
    run?: typeof runCentralIntegrationFileSpool;
  }) =>
  async (context: {
    invocation: PublicReleaseInvocation;
    plan: CentralHostSetupPlan;
    assertCurrent: () => Promise<void>;
  }) => {
    const { plan, invocation } = context;
    const assertCurrent = async () => {
      invocation.signal.throwIfAborted();
      await context.assertCurrent();
      invocation.signal.throwIfAborted();
    };
    await assertCurrent();
    const source = z
      .looseObject({
        buildReceiptSha256: digest,
        deploymentProfile: z.literal(profile),
      })
      .parse(plan.source);
    const worker = input.configuration.centralIntegrationWorker;
    if (worker === undefined) {
      throw unavailable();
    }
    const expected = centralIntegrationSourceCaptureSchema.parse({
      sourceSha: plan.source.reviewedSourceSha,
      deploymentProfile: profile,
      serviceIds: plan.source.serviceIds,
      servicesManifestSha256: plan.source.servicesManifestSha256,
      workers: plan.source.workers,
    });
    const profileEntries = plan.environment.filter(
      (entry) => entry.key === "AUTOGRAPH_DEPLOYMENT_PROFILE",
    );
    const matches = [
      isDeepStrictEqual(invocation.authority, plan.authority),
      invocation.sessionId === plan.selection.sessionId,
      worker.id === plan.source.workers.schema.id,
      worker.sha256 === plan.source.workers.schema.sha256,
      worker.operationScope === "central-integration-bootstrap-v1",
      profileEntries.length === 1,
      profileEntries[0]?.sha256 === hash(profile),
    ];
    if (matches.includes(false)) {
      throw unavailable();
    }
    const resource = plan.control.resource;
    const wire: CentralSourceCaptureContextWire = {
      version: 1,
      kind: "central_source_capture",
      app_id: "integrations",
      // This fresh inspection epoch controls only the read-only file protocol.
      // No database fence, mutation authorization or approval receipt is minted.
      operation: {
        operation_id: centralHostOperationRef(plan),
        approval_digest: centralHostPlanDigest(plan),
        fence_generation: 1,
      },
      source: {
        repository_id: plan.source.repositoryId,
        reviewed_source_sha: plan.source.reviewedSourceSha,
        deployment_profile: profile,
        services_manifest_sha256: plan.source.servicesManifestSha256,
        build_receipt_sha256: source.buildReceiptSha256,
      },
      resource: {
        resource_id: resource.resourceId,
        environment: "preview",
        hostname: resource.hostname,
        port: resource.port,
        database: resource.database,
        schema: resource.schema,
        migrator_role: resource.migratorRole,
        runtime_role: plan.control.centralRuntimeRole,
        provider_project_id: plan.control.neon.projectId,
        provider_branch_id: plan.control.neon.branchId,
        provider_endpoint_id: plan.control.neon.endpointId,
      },
      release: { id: plan.source.reviewedSourceSha, sha256: source.buildReceiptSha256 },
      installer: { id: worker.id, sha256: worker.sha256 },
      tenant_targets: [],
    };
    const result = await (input.run ?? runCentralIntegrationFileSpool)(input.configuration, {
      worker: { ...worker, subcommand: "central-integration-source-capture" },
      context: wire,
      runId: randomUUID(),
      startupFiles: {
        "central-integration-approved-plan.json": centralHostCanonicalBytes(z.json().parse(plan)),
      },
      readOnly: true,
      signal: invocation.signal,
      assertCurrent,
    });
    await assertCurrent();
    const observed = z
      .object({
        status: z.literal("applied"),
        readback_sha256: digest,
        receipt: centralIntegrationSourceCaptureSchema,
      })
      .parse(result);
    if (
      !isDeepStrictEqual(observed.receipt, expected) ||
      observed.readback_sha256 !== hash(centralHostCanonicalBytes(z.json().parse(observed.receipt)))
    ) {
      throw unavailable();
    }
    return observed.receipt;
  };
