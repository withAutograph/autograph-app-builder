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
  sha256: "a".repeat(64),
  operationScope: "generated-app-release-install-v1" as const,
  subcommand: "protected-generated-app-install" as const,
};
const resource = (name: string) => ({
  database: name,
  migratorRole: `${name}_owner`,
  runtimeRole: `${name}_runtime`,
  resourceId: `${name}-resource`,
});
const workload = {
  audience: "https://vercel.com/team",
  issuer: "https://oidc.vercel.com/team",
  ownerId: "team",
  projectId: "builder",
  environment: "preview" as const,
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
  teamId: "team",
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
  operator: {
    deploymentId: "operator-deployment",
    environment: "preview",
    origin: "https://operator.example",
    projectId: "operator",
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
        issuer: workload.issuer,
        ownerId: workload.ownerId,
        environment: workload.environment,
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
  sandbox: {
    accessWorker: worker,
    authWorker: worker,
    authProposal: { executablePath: "/trusted/propose", id: "proposal", sha256: "c".repeat(64) },
    resourcesWorker: worker,
    image: "trusted-image",
    projectId: "operator",
    teamId: "team",
    workers: { sibling: worker },
  },
  workloadPolicy: { ...workload },
});
const authority = {
  issuer: "https://builder.example/api/auth",
  audience: "https://builder.example/mcp",
  workspaceId: "workspace",
  ownerUserId: "owner",
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
  const profile = { id: "isolated", authority, appId: "new-app", configuration: selected };
  return { base, selected, profile };
};
const resolve = (
  profile: object[],
  overrides: Partial<Parameters<typeof resolveNativeTargetResourceProfile>[0]> = {},
) => {
  const { base } = fixture();
  return resolveNativeTargetResourceProfile({
    base,
    authority,
    appId: "new-app",
    resourceProfileId: "isolated",
    environment: { PROTECTED_HOSTED_OPERATOR_RESOURCE_PROFILES: JSON.stringify(profile) },
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
      resolveNativeTargetResourceProfile({ base, authority, appId: "other-app", environment: {} }),
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
        base,
        authority,
        appId: "new-app",
        resourceProfileId: "isolated",
        environment: {},
      }),
    ).toThrow();
    expect(() => resolve([{ id: "isolated" }])).toThrow();
    expect(() =>
      resolveNativeTargetResourceProfile({
        base,
        authority,
        appId: "new-app",
        resourceProfileId: "isolated",
        environment: { PROTECTED_HOSTED_OPERATOR_RESOURCE_PROFILES: "{" },
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
      runtimeRole: before.authDatabase.runtimeRole,
      resourceId: before.authDatabase.resourceId,
      migratorRole: before.authDatabase.migratorRole,
      database: before.authDatabase.database,
    };
    after.nativeNeon.scope = {
      projectId: before.nativeNeon.scope.projectId,
      maintenanceRole: before.nativeNeon.scope.maintenanceRole,
      maintenanceDatabase: before.nativeNeon.scope.maintenanceDatabase,
      hostname: before.nativeNeon.scope.hostname,
      endpointId: before.nativeNeon.scope.endpointId,
      branchId: before.nativeNeon.scope.branchId,
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
