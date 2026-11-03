import { publicReleasePlanSchema } from "./public-release-contract";

export const authority = {
  issuer: "https://builder.example/api/auth",
  audience: "https://builder.example/mcp",
  workspaceId: "workspace",
  ownerUserId: "owner",
};
export const plan = publicReleasePlanSchema.parse({
  version: 1,
  kind: "public-app-release-v1",
  authority,
  selection: { appId: "invoice-app", sessionId: "saved-session" },
  project: {
    projectId: "owned-project",
    teamId: "team",
    installationId: "installation",
    provisioningRequestId: "11111111-1111-4111-a111-111111111111",
    provisioningDigest: "a".repeat(64),
    framework: "services",
    rootDirectory: ".",
    deploymentAccess: "public-app",
    environment: "production",
  },
  source: {
    repositoryId: "owned-repository",
    sourceBranch: "builder/app",
    sourceSha: "a".repeat(40),
    productionBranch: "main",
    expectedProductionSha: "e".repeat(40),
    reviewDigest: "b".repeat(64),
  },
  runtime: {
    operationRef: "22222222-2222-4222-a222-222222222222",
    planDigest: "c".repeat(64),
    configurationRef: "protected-runtime-reference",
    releaseId: "app-release",
    providerEnvironment: "development",
    syntheticOnly: true,
  },
  publicOrigin: "https://app.example",
  environment: [{ key: "APP_DATABASE_URL", sha256: "d".repeat(64) }],
  effects: ["bind-production-runtime", "publish-release-source"],
});
