import { describe, expect, it } from "vitest";
import type { HostedOperatorSourceConfiguration } from "./hosted-operator-source-configuration";
import { validateHostedOperatorSourceConfiguration } from "./hosted-operator-source-configuration";

import {
  nativeTargetResourceProfileAuthorityDigest,
  resolveNativeTargetResourceProfile,
} from "./native-target-resource-profile";

const worker = {
  executablePath: "/trusted/install",
  id: "trusted-installer",
  operationScope: "generated-app-release-install-v1" as const,
  sha256: "a".repeat(64),
  subcommand: "protected-generated-app-install" as const,
};
const resource = (name: string) => ({
  database: name,
  migratorRole: `${name}_owner`,
  resourceId: `${name}-resource`,
  runtimeRole: `${name}_runtime`,
});
const workload = {
  audience: "https://vercel.com/team",
  environment: "preview" as const,
  issuer: "https://oidc.vercel.com/team",
  ownerId: "team",
  projectId: "builder",
  subject: "builder-workload",
};
const configuration = (): HostedOperatorSourceConfiguration => ({
  applications: {
    sibling: {
      accessRoles: ["reviewer"],
      appDatabase: resource("sibling"),
      branch: "main",
      projectId: "sibling-project",
    },
  },
  authDatabase: resource("auth"),
  builderCallbackOrigin: "https://builder.example",
  catalogAppIds: ["sibling"],
  gateway: {
    authBrowserOrigin: "https://auth.example",
    branch: "main",
    environment: "preview",
    gatewayOrigin: "https://gateway.example",
    gitSha: "b".repeat(40),
    projectId: "gateway",
    protectedApplicationIds: ["sibling"],
    publicOrigin: "https://apps.example",
    repoId: "gateway-repository",
    workload: { ...workload, projectId: "gateway" },
  },
  nativeNeon: {
    configuration: {
      connector: "approved-connector",
      nativeStore: {
        configurationId: "approved-store",
        resourceId: "store",
        sourceProjectId: "operator",
      },
      operator: {
        audience: workload.audience,
        environment: workload.environment,
        issuer: workload.issuer,
        ownerId: workload.ownerId,
        projectId: "operator",
      },
    },
    scope: {
      branchId: "br-shared",
      endpointId: "ep-shared",
      hostname: "ep-shared.neon.tech",
      maintenanceDatabase: "neondb",
      maintenanceRole: "neondb_owner",
      projectId: "shared-neon",
    },
  },
  operator: {
    deploymentId: "operator-deployment",
    environment: "preview",
    origin: "https://operator.example",
    projectId: "operator",
  },
  sandbox: {
    accessWorker: worker,
    authProposal: { executablePath: "/trusted/propose", id: "proposal", sha256: "c".repeat(64) },
    authWorker: worker,
    image: "trusted-image",
    projectId: "operator",
    resourcesWorker: worker,
    teamId: "team",
    workers: { sibling: worker },
  },
  teamId: "team",
  workloadPolicy: { ...workload },
});
const authority = {
  audience: "https://builder.example/mcp",
  issuer: "https://builder.example/api/auth",
  ownerUserId: "owner",
  workspaceId: "workspace",
};
const selectedConfig = () => {
  const result = configuration();
  result.authDatabase = resource("isolated_auth");
  result.nativeNeon.scope.projectId = "isolated-neon";
  result.nativeNeon.scope.branchId = "br-isolated";
  result.nativeNeon.configuration.nativeStore.resourceId = "isolated-store";
  result.gateway.gatewayOrigin = "https://isolated-gateway.example";
  return result;
};
const fixture = () => {
  const base = configuration();
  const selected = selectedConfig();
  const profile = { appId: "new-app", authority, configuration: selected, id: "isolated" };
  return { base, profile, selected };
};
const resolve = (
  profile: object[],
  overrides: Partial<Parameters<typeof resolveNativeTargetResourceProfile>[0]> = {},
) => {
  const { base } = fixture();
  return resolveNativeTargetResourceProfile({
    appId: "new-app",
    authority,
    base,
    environment: { PROTECTED_HOSTED_OPERATOR_RESOURCE_PROFILES: JSON.stringify(profile) },
    resourceProfileId: "isolated",
    ...overrides,
  });
};

describe("native target deployment resource profile", () => {
  it("selects a coherent private configuration for the exact owner and app", () => {
    const { profile, selected } = fixture();
    validateHostedOperatorSourceConfiguration(profile.configuration);

    expect(resolve([profile])).toEqual(selected);
  });
  it("preserves the legacy base when no profile is selected", () => {
    const { base } = fixture();
    expect(
      resolveNativeTargetResourceProfile({ appId: "other-app", authority, base, environment: {} }),
    ).toBe(base);
  });
  it("rejects mismatched owners, apps, selectors and duplicate profiles", () => {
    const { profile } = fixture();
    expect(() =>
      resolve([profile], { authority: { ...authority, ownerUserId: "other" } }),
    ).toThrow();
    expect(() => resolve([profile], { appId: "other-app" })).toThrow();
    expect(() => resolve([profile], { resourceProfileId: "missing" })).toThrow();
    expect(() => resolve([profile, profile])).toThrow();
  });
  it("rejects missing and malformed private configuration", () => {
    const { base } = fixture();
    expect(() =>
      resolveNativeTargetResourceProfile({
        appId: "new-app",
        authority,
        base,
        environment: {},
        resourceProfileId: "isolated",
      }),
    ).toThrow();
    expect(() => resolve([{ id: "isolated" }])).toThrow();
    expect(() =>
      resolveNativeTargetResourceProfile({
        appId: "new-app",
        authority,
        base,
        environment: { PROTECTED_HOSTED_OPERATOR_RESOURCE_PROFILES: "{" },
        resourceProfileId: "isolated",
      }),
    ).toThrow();
  });
  it.each(["workload", "operator", "team", "callback", "sandbox", "gateway"] as const)(
    "rejects a changed %s authority boundary or invalid coherent configuration",
    (field) => {
      const { profile } = fixture();
      const config = profile.configuration;
      switch (field) {
        case "workload": {
          config.workloadPolicy.subject = "foreign";
          break;
        }
        case "operator": {
          config.operator.origin = "https://other.example";
          break;
        }
        case "team": {
          config.teamId = "other-team";
          break;
        }
        case "callback": {
          config.builderCallbackOrigin = "https://other.example";
          break;
        }
        case "sandbox": {
          config.sandbox.projectId = "other-project";
          break;
        }
        case "gateway": {
          config.gateway.workload.projectId = "wrong-project";
          break;
        }
        default: {
          throw new Error("Unexpected fixture");
        }
      }
      expect(() => resolve([profile])).toThrow();
    },
  );
});

describe("native target resource profile authority digest", () => {
  it.each(["auth", "neon", "gateway", "capability"] as const)(
    "changes when %s resource authority changes",
    (field) => {
      const before = selectedConfig();
      const after = structuredClone(before);
      switch (field) {
        case "auth": {
          after.authDatabase.database = "different_auth";
          break;
        }
        case "neon": {
          after.nativeNeon.scope.branchId = "br-other";
          break;
        }
        case "gateway": {
          after.gateway.publicOrigin = "https://other.example";
          break;
        }
        case "capability": {
          after.sandbox.resourcesWorker.operationScope = "auth-protected-schema-v1";
          break;
        }
        default: {
          throw new Error("Unexpected fixture");
        }
      }
      expect(nativeTargetResourceProfileAuthorityDigest(after)).not.toBe(
        nativeTargetResourceProfileAuthorityDigest(before),
      );
    },
  );
  it("is independent of property construction order", () => {
    const before = selectedConfig();
    const after = structuredClone(before);
    after.authDatabase = {
      database: before.authDatabase.database,
      migratorRole: before.authDatabase.migratorRole,
      resourceId: before.authDatabase.resourceId,
      runtimeRole: before.authDatabase.runtimeRole,
    };
    after.nativeNeon.scope = {
      branchId: before.nativeNeon.scope.branchId,
      endpointId: before.nativeNeon.scope.endpointId,
      hostname: before.nativeNeon.scope.hostname,
      maintenanceDatabase: before.nativeNeon.scope.maintenanceDatabase,
      maintenanceRole: before.nativeNeon.scope.maintenanceRole,
      projectId: before.nativeNeon.scope.projectId,
    };
    expect(nativeTargetResourceProfileAuthorityDigest(after)).toBe(
      nativeTargetResourceProfileAuthorityDigest(before),
    );
  });
  it("ignores source, deployment, sandbox image and worker byte changes", () => {
    const before = selectedConfig();
    const after = structuredClone(before);
    after.gateway.gitSha = "d".repeat(40);
    after.gateway.deploymentId = "new-gateway-deployment";
    after.operator.deploymentId = "new-operator-deployment";
    if ("image" in after.sandbox) {
      after.sandbox.image = "new-image";
    }
    after.sandbox.resourcesWorker.executablePath = "/other/worker";
    after.sandbox.resourcesWorker.sha256 = "e".repeat(64);
    expect(nativeTargetResourceProfileAuthorityDigest(after)).toBe(
      nativeTargetResourceProfileAuthorityDigest(before),
    );
  });
  it("permits a new operator deployment under the same operator identity", () => {
    const { profile, selected } = fixture();
    profile.configuration.operator.deploymentId = "new-operator-deployment";
    expect(resolve([profile])).toEqual(selected);
  });
});
