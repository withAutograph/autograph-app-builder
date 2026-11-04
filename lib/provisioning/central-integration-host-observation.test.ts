/* oxlint-disable eslint/require-await -- Closed readonly observation fixtures. */
import { expect, test, vi } from "vitest";
import { plan, ready } from "./central-integration-host-test-fixture";
import {
  centralHostPlanDigest,
  centralHostOperationRef,
} from "./central-integration-host-contract";
import { centralHostRecordSchema } from "./central-integration-host-store";
import { createCentralHostObservation } from "./central-integration-host-observation";
const fixture = () => {
  const manifest = {
    applicationIngress: plan.source.applicationIngress,
    deploymentProfile: plan.source.deploymentProfile,
    profileId: plan.profile.id,
    profileDigest: plan.profile.digest,
    resourceProfileId: plan.resourceProfileId,
    configurationRef: plan.source.configurationRef,
    configurationSha256: plan.source.configurationSha256,
    control: {
      hostname: plan.control.resource.hostname,
      port: 5432,
      database: plan.control.resource.database,
      schema: "public",
      runtimeRole: plan.control.centralRuntimeRole,
      neon: plan.control.neon,
      schemaSha256: plan.control.schemaSha256,
    },
    activation: { keyId: plan.activation.keyId, publicKeySha256: plan.activation.publicKeySha256 },
    deployment: {
      projectId: plan.target.projectId,
      teamId: plan.target.teamId,
      environment: "preview",
      serviceId: "integrations",
    },
  };
  const event = {
    eventId: "native-created",
    eventType: "deployment.created",
    bodySha256: "a".repeat(64),
    projectId: plan.target.projectId,
    teamId: plan.target.teamId,
    providerDeploymentId: ready.deployment.providerDeploymentId,
    immutableOrigin: ready.deployment.immutableOrigin,
  };
  const row = {
    operationRef: centralHostOperationRef(plan),
    revision: 4,
    record: centralHostRecordSchema.parse({
      kind: "central-integration-host-journal-v1",
      plan,
      planDigest: centralHostPlanDigest(plan),
      effects: Object.fromEntries(
        plan.effects.map((effect, index) => [effect, index < 2 ? "applied" : "idle"]),
      ),
      approvalReceipts: [{ approvedByCallId: "approved-call", approvedAt: "2026-11-03T00:00:00Z" }],
      executionLease: { leaseId: "22222222-2222-4222-a222-222222222222", fenceGeneration: 9 },
      nativeDeployment: {
        status: "accepted",
        providerDeploymentId: event.providerDeploymentId,
        immutableOrigin: event.immutableOrigin,
        events: [event],
      },
      attempts: {
        "prepare-central-resources": {
          attemptId: "33333333-3333-4333-a333-333333333333",
          attemptGeneration: 7,
          receipt: {
            effect: "prepare-central-resources",
            resourceId: plan.control.resource.resourceId,
            resourceVersion: "actual-resource-version",
            readbackSha256: "a".repeat(64),
          },
        },
        "install-central-schema": {
          attemptId: "11111111-1111-4111-a111-111111111111",
          attemptGeneration: 7,
          receipt: {
            effect: "install-central-schema",
            schemaSha256: plan.control.schemaSha256,
            resourceProfileId: plan.resourceProfileId,
            configurationSha256: plan.source.configurationSha256,
            centralPrincipalGeneration: 7,
          },
        },
      },
    }),
  };
  const observation = {
    version: 1,
    kind: "central-integrations-readiness-v1",
    ...manifest,
    centralPrincipalGeneration: 7,
    deployment: {
      ...manifest.deployment,
      providerDeploymentId: event.providerDeploymentId,
      immutableOrigin: event.immutableOrigin,
    },
  };
  const provider = {
    observeDeployment: vi.fn(async () => true),
    assertInheritedEnvironment: vi.fn(async () => {}),
  };
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    expect(url).toEqual(new URL("/integrations/internal/central-readiness", event.immutableOrigin));
    expect(init?.redirect).toBe("error");
    expect(init?.headers).toMatchObject({
      authorization: "Bearer own-inspector-token",
      "x-vercel-trusted-oidc-idp-token": "own-inspector-token",
    });
    return Response.json(observation);
  });
  const read = createCentralHostObservation({
    provider,
    assertCurrent: async () => {},
    readValues: async () => ({ INTEGRATIONS_CENTRAL_CONFIGURATION: JSON.stringify(manifest) }),
    token: async () => "own-inspector-token",
    fetch: fetcher,
  });
  const invocation = {
    authority: plan.authority,
    sessionId: plan.selection.sessionId,
    callId: "read",
    signal: new AbortController().signal,
  };
  return { read, row, invocation, provider, fetcher, observation };
};
test("ready requires accepted-ID provider readback on both sides of independent loaded SQL observation", async () => {
  const f = fixture();
  await expect(f.read(f.invocation, f.row)).resolves.toBe(true);
  expect(f.provider.observeDeployment).toHaveBeenCalledTimes(2);
  expect(f.fetcher).toHaveBeenCalledOnce();
});
test("a missing accepted native identity cannot elect another deployment", async () => {
  const f = fixture();
  delete f.row.record.nativeDeployment;
  await expect(f.read(f.invocation, f.row)).resolves.toBe(false);
  expect(f.provider.observeDeployment).not.toHaveBeenCalled();
  expect(f.fetcher).not.toHaveBeenCalled();
});
test("stale loaded configuration is refused even with matching project and accepted deployment", async () => {
  const f = fixture();
  f.observation.configurationSha256 = "0".repeat(64);
  await expect(f.read(f.invocation, f.row)).rejects.toThrow("central_host_readiness_unavailable");
});
test("actual SQL principal generation must match accepted schema effect, not current lease generation", async () => {
  const f = fixture();
  f.observation.centralPrincipalGeneration = 8;
  await expect(f.read(f.invocation, f.row)).rejects.toThrow("central_host_readiness_unavailable");
});
test("provider state changing after HTTP observation keeps readiness false", async () => {
  const f = fixture();
  f.provider.observeDeployment.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await expect(f.read(f.invocation, f.row)).resolves.toBe(false);
});
