import { publicReleasePlanSchema } from "./public-release-contract";

export const authority = {
  audience: "https://builder.example/mcp",
  issuer: "https://builder.example/api/auth",
  ownerUserId: "owner",
  workspaceId: "workspace",
};
export const plan = publicReleasePlanSchema.parse({
  authority,
  effects: ["bind-production-runtime", "publish-release-source"],
  environment: [{ key: "INVOICE_APP_DATABASE_URL", sha256: "d".repeat(64) }],
  kind: "public-app-release-v1",
  project: {
    deploymentAccess: "public-app",
    environment: "production",
    framework: "services",
    installationId: "installation",
    priorActiveDeploymentId: null,
    projectId: "owned-project",
    provisioningDigest: "a".repeat(64),
    provisioningRequestId: "11111111-1111-4111-a111-111111111111",
    rootDirectory: ".",
    teamId: "team",
  },
  publicOrigin: "https://app.example",
  runtime: {
    configurationRef: "protected-runtime-reference",
    operationRef: "22222222-2222-4222-a222-222222222222",
    planDigest: "c".repeat(64),
    providerEnvironment: "development",
    releaseId: "app-release",
    syntheticOnly: true,
  },
  selection: { appId: "invoice-app", sessionId: "saved-session" },
  source: {
    deliveryScope: {
      kind: "builder-created-app-repository",
      provisioningDigest: "a".repeat(64),
      provisioningRequestId: "11111111-1111-4111-a111-111111111111",
    },
    expectedProductionSha: "e".repeat(40),
    installationId: "github-installation",
    productionBranch: "main",
    repositoryId: "owned-repository",
    reviewDigest: "b".repeat(64),
    sourceBranch: "builder/app",
    sourceSha: "a".repeat(40),
  },
  version: 1,
});
