import { describe, expect, it } from "vitest";
import { repositoryProductionConfigurationSchema } from "./repository-production-configuration";

const workload = {
  audience: "https://vercel.com/team",
  environment: "production",
  issuer: "https://oidc.vercel.com/team",
  ownerId: "team",
  projectId: "operator",
  subject: "operator-subject",
};
const genericWorker = { executablePath: "/worker", sha256: "a".repeat(64) };
const repository = {
  authOperatorRole: "auth_operator",
  authResource: {
    database: "auth",
    migratorRole: "auth_migrator",
    resourceId: "auth",
    runtimeRole: "auth_runtime",
  },
  authWorkload: workload,
  neon: {
    branchId: "br-production",
    endpoint: "ep-production.us-east-1.aws.neon.tech",
    endpointId: "ep-production",
    maintenanceDatabase: "neondb",
    maintenanceRole: "maintenance",
    projectId: "neon-project",
  },
  organization: { id: "organization", name: "Organization" },
  projectId: "apps",
  publicOrigin: "https://apps.example",
  repositoryFullName: "team/repo",
  repositoryId: "repo",
  workspaceId: "workspace",
};
const secretConnection = {
  authOperatorEnvironment: "REPO_AUTH_OPERATOR",
  authRuntimeEnvironment: "REPO_AUTH_RUNTIME",
  kind: "deployment-secrets",
  maintenanceUrlEnvironment: "REPO_MAINTENANCE",
};
const connect = {
  connector: "neon/production",
  installationId: "production-installation",
  subject: { id: "owner", issuer: "https://builder.example", type: "user" },
};
const base = {
  builderWorkload: workload,
  operator: workload,
  sandbox: { image: "operator-image", projectId: "operator", teamId: "team" },
  vercelCredential: {
    authority: {
      audience: "https://builder.example/mcp",
      issuer: "https://builder.example/api/auth",
      ownerUserId: "owner",
      workspaceId: "workspace",
    },
    installationId: "vercel-installation",
  },
  version: 1,
  workers: {
    access: {
      ...genericWorker,
      id: "generated-app-protected-installer-v1",
      operationScope: "generated-app-access-v1",
      subcommand: "protected-generated-app-access",
    },
    authManagement: {
      ...genericWorker,
      id: "auth-app-access-v1",
      operationScope: "auth-app-access-v1",
      subcommand: "auth-protected-app-access",
    },
    membership: {
      ...genericWorker,
      id: "auth-owned-organization-v1",
      operationScope: "auth-protected-membership-v1",
      subcommand: "auth-protected-membership",
    },
    schema: {
      ...genericWorker,
      id: "generated-app-protected-installer-v1",
      operationScope: "generated-app-release-install-v1",
      subcommand: "protected-generated-app-install",
    },
    storage: {
      ...genericWorker,
      id: "neon-resource-bootstrap-v1",
      operationScope: "neon-resource-bootstrap-v1",
      subcommand: "neon-resource-bootstrap",
    },
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

  it.each([undefined, "auth_migrator", "auth_runtime", "unsafe-role"])(
    "requires a distinct explicit Auth operator role (%s)",
    (authOperatorRole) => {
      expect(
        repositoryProductionConfigurationSchema.safeParse({
          ...base,
          connection: connect,
          repositories: [{ ...repository, authOperatorRole }],
        }).success,
      ).toBe(false);
    },
  );

  it("does not accept the old owner credential as an operator binding", () => {
    const { authOperatorEnvironment: _operator, ...otherBindings } = secretConnection;
    void _operator;
    expect(
      repositoryProductionConfigurationSchema.safeParse({
        ...base,
        connection: connect,
        repositories: [
          {
            ...repository,
            connection: { ...otherBindings, authMigratorEnvironment: "REPO_AUTH_MIGRATOR" },
          },
        ],
      }).success,
    ).toBe(false);
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
