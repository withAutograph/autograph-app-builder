import { describe, expect, it } from "vitest";
import { repositoryProductionConfigurationSchema } from "./repository-production-configuration";

const workload = {
  audience: "https://vercel.com/team",
  issuer: "https://oidc.vercel.com/team",
  ownerId: "team",
  projectId: "operator",
  subject: "operator-subject",
  environment: "production",
};
const genericWorker = { executablePath: "/worker", sha256: "a".repeat(64) };
const repository = {
  workspaceId: "workspace",
  projectId: "apps",
  repositoryId: "repo",
  repositoryFullName: "team/repo",
  organization: { id: "organization", name: "Organization" },
  publicOrigin: "https://apps.example",
  authWorkload: workload,
  authResource: {
    resourceId: "auth",
    database: "auth",
    migratorRole: "auth_migrator",
    runtimeRole: "auth_runtime",
  },
  neon: {
    endpoint: "ep-production.us-east-1.aws.neon.tech",
    projectId: "neon-project",
    branchId: "br-production",
    endpointId: "ep-production",
    maintenanceDatabase: "neondb",
    maintenanceRole: "maintenance",
  },
};
const secretConnection = {
  kind: "deployment-secrets",
  maintenanceUrlEnvironment: "REPO_MAINTENANCE",
  authMigratorEnvironment: "REPO_AUTH_MIGRATOR",
  authRuntimeEnvironment: "REPO_AUTH_RUNTIME",
};
const connect = {
  connector: "neon/production",
  installationId: "production-installation",
  subject: { id: "owner", issuer: "https://builder.example", type: "user" },
};
const base = {
  version: 1,
  builderWorkload: workload,
  operator: workload,
  sandbox: { image: "operator-image", projectId: "operator", teamId: "team" },
  workers: {
    storage: {
      ...genericWorker,
      id: "neon-resource-bootstrap-v1",
      operationScope: "neon-resource-bootstrap-v1",
      subcommand: "neon-resource-bootstrap",
    },
    schema: {
      ...genericWorker,
      id: "generated-app-protected-installer-v1",
      operationScope: "generated-app-release-install-v1",
      subcommand: "protected-generated-app-install",
    },
    access: {
      ...genericWorker,
      id: "generated-app-protected-installer-v1",
      operationScope: "generated-app-access-v1",
      subcommand: "protected-generated-app-access",
    },
    membership: {
      ...genericWorker,
      id: "auth-owned-organization-v1",
      operationScope: "auth-protected-membership-v1",
      subcommand: "auth-protected-membership",
    },
    authManagement: {
      ...genericWorker,
      id: "auth-app-access-v1",
      operationScope: "auth-app-access-v1",
      subcommand: "auth-protected-app-access",
    },
  },
  vercelCredential: {
    authority: {
      issuer: "https://builder.example/api/auth",
      audience: "https://builder.example/mcp",
      workspaceId: "workspace",
      ownerUserId: "owner",
    },
    installationId: "vercel-installation",
  },
};

describe("Production repository connection configuration", () => {
  it("accepts a deployment binding without requiring an unrelated Connect credential", () => {
    const configuration = repositoryProductionConfigurationSchema.parse({
      ...base,
      repositories: [{ ...repository, connection: secretConnection }],
    });
    expect(configuration.connection).toBeUndefined();
    expect(configuration.repositories[0]?.connection?.authRuntimeEnvironment).toBe(
      "REPO_AUTH_RUNTIME",
    );
  });

  it("keeps existing managed Connect configuration compatible", () => {
    expect(
      repositoryProductionConfigurationSchema.safeParse({
        ...base,
        connection: connect,
        repositories: [repository],
      }).success,
    ).toBe(true);
  });

  it("rejects any repository that has no explicit connection authority", () => {
    expect(
      repositoryProductionConfigurationSchema.safeParse({ ...base, repositories: [repository] })
        .success,
    ).toBe(false);
    expect(
      repositoryProductionConfigurationSchema.safeParse({
        ...base,
        repositories: [
          { ...repository, connection: secretConnection },
          { ...repository, repositoryId: "another-repo" },
        ],
      }).success,
    ).toBe(false);
  });

  it("does not ignore an invalid explicit binding even when Connect is also configured", () => {
    expect(
      repositoryProductionConfigurationSchema.safeParse({
        ...base,
        connection: connect,
        repositories: [
          { ...repository, connection: { ...secretConnection, authRuntimeEnvironment: "" } },
        ],
      }).success,
    ).toBe(false);
  });
});
