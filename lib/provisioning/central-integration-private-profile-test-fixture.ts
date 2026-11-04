import { plan } from "./central-integration-host-test-fixture";
import { centralIntegrationPrivateProfileSchema } from "./central-integration-private-profile";
export const centralPrivateProfileFixture = () =>
  centralIntegrationPrivateProfileSchema.parse({
    version: 1,
    id: plan.profile.id,
    resourceProfileId: plan.resourceProfileId,
    owners: [plan.authority],
    isolation: "dedicated-development",
    target: plan.target,
    control: plan.control,
    provider: plan.provider,
    source: {
      repositoryId: plan.source.repositoryId,
      installationId: plan.source.installationId,
      reviewedSourceSha: plan.source.reviewedSourceSha,
      reviewDigest: plan.source.reviewDigest,
      servicesManifestSha256: plan.source.servicesManifestSha256,
      serviceIds: plan.source.serviceIds,
      applicationIngress: plan.source.applicationIngress,
      deploymentProfile: plan.source.deploymentProfile,
      buildReceiptSha256: plan.source.buildReceiptSha256,
      workers: plan.source.workers,
      sourceBranch: "main",
    },
    inspector: {
      issuer: "https://oidc.vercel.com/owned-team",
      audience: "https://vercel.com/owned-team",
      subject: "owner:owned-team:project:operator:environment:preview",
      ownerId: plan.target.teamId,
      projectId: plan.inspector.projectId,
      environment: plan.inspector.environment,
    },
    receiver: { publicOrigin: plan.receiver.publicOrigin },
    private: {
      providerApiKey: "isolated-provider-private-key",
      providerWebhookSigningSecret: "isolated-central-webhook-signing-secret",
      bootstrap: {
        connectionString: `postgresql://bootstrap:private-password@${plan.control.resource.hostname}:5432/postgres?sslmode=verify-full`,
        maintenanceDatabase: "postgres",
        bootstrapRole: "bootstrap",
        productionDatabaseIdentity: "ep-production.neon.tech/customer",
      },
    },
  });
