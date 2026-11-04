import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { CentralHostRow } from "./central-integration-host-store";
import type { CentralHostSetupPlan } from "./central-integration-host-contract";
import type { PublicReleaseInvocation } from "./public-release-handler";
import type { createCentralIntegrationVercelProvider } from "./central-integration-vercel-provider";

const id = z.string().min(1);
const unavailable = () => new Error("central_host_readiness_unavailable");
/** Observe only the signed accepted native ID; source SHA validates provenance after identity selection. */
export const createCentralHostObservation =
  (input: {
    provider: Pick<
      ReturnType<typeof createCentralIntegrationVercelProvider>,
      "observeDeployment" | "assertInheritedEnvironment"
    >;
    assertCurrent: (
      invocation: PublicReleaseInvocation,
      plan: CentralHostSetupPlan,
    ) => Promise<void>;
    readValues: (
      invocation: PublicReleaseInvocation,
      plan: CentralHostSetupPlan,
    ) => Promise<Readonly<Record<string, string>>>;
    token: () => Promise<string>;
    fetch?: typeof fetch;
  }) =>
  async (invocation: PublicReleaseInvocation, row: CentralHostRow): Promise<boolean> => {
    if (
      row.record.plan.kind !== "central-integration-host-setup-v1" ||
      row.record.nativeDeployment?.status !== "accepted"
    )
      return false;
    const plan = row.record.plan,
      accepted = row.record.nativeDeployment;
    await input.assertCurrent(invocation, plan);
    await input.provider.assertInheritedEnvironment(plan, invocation.signal);
    if (!(await input.provider.observeDeployment(plan, accepted, invocation.signal))) return false;
    const values = await input.readValues(invocation, plan);
    const manifest = z
      .record(z.string(), z.json())
      .parse(JSON.parse(values.INTEGRATIONS_CENTRAL_CONFIGURATION ?? "null"));
    const expected = {
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
      activation: {
        keyId: plan.activation.keyId,
        publicKeySha256: plan.activation.publicKeySha256,
      },
      deployment: {
        projectId: plan.target.projectId,
        teamId: plan.target.teamId,
        environment: "preview",
        serviceId: "integrations",
      },
    };
    if (!isDeepStrictEqual(manifest, expected)) throw unavailable();
    await input.assertCurrent(invocation, plan);
    const workload = await input.token();
    await input.assertCurrent(invocation, plan);
    const response = await (input.fetch ?? fetch)(
      new URL("/integrations/internal/central-readiness", accepted.immutableOrigin),
      {
        method: "POST",
        redirect: "error",
        signal: invocation.signal,
        headers: {
          authorization: `Bearer ${workload}`,
          "x-vercel-trusted-oidc-idp-token": workload,
          "content-type": "application/json",
        },
        body: JSON.stringify({ ...manifest, providerDeploymentId: accepted.providerDeploymentId }),
      },
    );
    await input.assertCurrent(invocation, plan);
    if (!response.ok) return false;
    const observed = z
      .object({
        version: z.literal(1),
        kind: z.literal("central-integrations-readiness-v1"),
        centralPrincipalGeneration: z.number().int().positive().safe(),
        deployment: z.object({
          projectId: id,
          teamId: id,
          environment: z.literal("preview"),
          serviceId: z.literal("integrations"),
          providerDeploymentId: id,
          immutableOrigin: z.url(),
        }),
      })
      .passthrough()
      .parse(await response.json());
    const { version: _v, kind: _k, centralPrincipalGeneration, ...actual } = observed;
    void _v;
    void _k;
    if (
      !isDeepStrictEqual(actual, {
        ...expected,
        deployment: {
          ...expected.deployment,
          providerDeploymentId: accepted.providerDeploymentId,
          immutableOrigin: accepted.immutableOrigin,
        },
      })
    )
      throw unavailable();
    const receipt = row.record.attempts?.["install-central-schema"]?.receipt;
    if (
      receipt?.effect !== "install-central-schema" ||
      receipt.centralPrincipalGeneration !== centralPrincipalGeneration
    )
      throw unavailable();
    await input.assertCurrent(invocation, plan);
    return await input.provider.observeDeployment(plan, accepted, invocation.signal);
  };
