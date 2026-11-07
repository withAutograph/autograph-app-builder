import { describe, expect, it } from "vitest";

import { nativeTargetAuthOnlyPlanDigest, nativeTargetAuthOnlySchemaEffectDigest } from "./native-target-auth-only-plan-schema";
import {
  planNativeTargetAuthOnly,
  planNativeTargetAuthOnlyFromOwnedState,
} from "./native-target-auth-only-planner";
import { nativeTargetRequiredProjectProtection } from "./native-target-onboarding-plan-schema";

const owner = {
  authority: {
    issuer: "https://builder.example/api/auth",
    audience: "https://builder.example/mcp",
    workspaceId: "workspace_fixture",
    ownerUserId: "owner_fixture",
  },
  publicSessionId: "public_original",
  adapterSessionId: "native_original",
  adapterGeneration: 1,
};
const description = {
  app: { id: "signup-reset-pilot", routes: ["/"], workspacePath: "apps/signup-reset-pilot" },
  backend: { kind: "static" },
  deployment: { framework: "nextjs", sourceFilesOutsideRootDirectory: true },
  validation: {
    browser: null,
    check: { task: "mise run app:check signup-reset-pilot" },
    test: null,
  },
  version: 1,
};
const profile = {
  id: "signup-reset-pilot-preview-auth",
  appId: "signup-reset-pilot",
  authority: owner.authority,
  configuration: {
    authDatabase: {
      resourceId: "isolated-auth-resource",
      database: "auth_identity",
      migratorRole: "auth_migrator",
      runtimeRole: "auth_runtime",
    },
  },
};
const authAuthorityBinding = {
  nativeNeon: { scope: { endpointId: "isolated-endpoint", hostname: "auth-preview.neon.tech" } },
  gateway: { projectId: "gateway-fixture", branch: "preview-fixture" },
};
const proposal = {
  appId: "signup-reset-pilot",
  authProfileId: profile.id,
  project: {
    name: "signup-reset-pilot",
    teamId: "team_fixture",
    installationId: "install_fixture",
  },
  branch: "main",
  appSpecDigest: "a".repeat(64),
  appRole: "pilot_user",
};
const makePlan = (overrides: Partial<Parameters<typeof planNativeTargetAuthOnly>[0]> = {}) =>
  planNativeTargetAuthOnly({
    owner,
    proposal,
    capturedDescription: description,
    selectedProfile: profile,
    sharedAuthResourceId: "shared-auth-resource",
    sharedPhysicalEndpointId: "shared-endpoint",
    selectedPhysicalEndpointId: "isolated-endpoint",
    authAuthorityBinding,
    configuredAppRoles: ["pilot_user"],
    publishedSource: { branch: "main", changeSetDigest: "c".repeat(64), gitSha: "d".repeat(40), gitTree: "e".repeat(40), repositoryId: "repo_fixture", reviewDigest: "f".repeat(64) },
    authSchema: { artifactRef: "auth-artifact", planDigest: "1".repeat(64), targetDigest: "2".repeat(64), installer: { reference: "auth-worker", sha256: "3".repeat(64) } },
    ...overrides,
  });

describe("native Auth-only planning", () => {
  it("binds schema approval to the exact published source, resource, role, and policy", () => {
    const plan = makePlan();
    const source = plan.publishedSource;
    const original = nativeTargetAuthOnlySchemaEffectDigest(plan, source);
    expect(nativeTargetAuthOnlySchemaEffectDigest(plan, { ...source, gitSha: "1".repeat(40) })).not.toBe(original);
    expect(nativeTargetAuthOnlySchemaEffectDigest({ ...plan, appRole: "pilot_reviewer" }, source)).not.toBe(original);
    expect(nativeTargetAuthOnlySchemaEffectDigest({ ...plan, authResource: { ...plan.authResource, resourceId: "different-auth-resource" } }, source)).not.toBe(original);
    expect(nativeTargetAuthOnlySchemaEffectDigest({ ...plan, authSchema: { ...plan.authSchema, artifactRef: "different-auth-artifact" } }, source)).not.toBe(original);
  });

  it("plans from captured static source and owner-bound isolated Auth profile", () => {
    const plan = makePlan();
    expect(plan).toMatchObject({
      appId: "signup-reset-pilot",
      project: {
        protection: nativeTargetRequiredProjectProtection,
        projectSettings: {
          framework: "nextjs",
          rootDirectory: "apps/signup-reset-pilot",
          sourceFilesOutsideRootDirectory: true,
        },
      },
      authResource: {
        profileId: profile.id,
        resourceId: profile.configuration.authDatabase.resourceId,
      },
      appRole: "pilot_user",
      signupPolicy: { eligibility: "approved-email-list", requireVerifiedEmail: true },
    });
    expect(plan).not.toHaveProperty("appDatabase");
    expect(plan).not.toHaveProperty("nativeNeon");
    expect(plan).not.toHaveProperty("worker");
  });

  it("binds description, Auth authority and role into the approval digest", () => {
    const original = makePlan();
    expect(
      nativeTargetAuthOnlyPlanDigest({
        ...original,
        authResource: { ...original.authResource, authorityDigest: "c".repeat(64) },
      }),
    ).not.toBe(nativeTargetAuthOnlyPlanDigest(original));
    expect(nativeTargetAuthOnlyPlanDigest({ ...original, appRole: "pilot_reviewer" })).not.toBe(
      nativeTargetAuthOnlyPlanDigest(original),
    );
    expect(
      nativeTargetAuthOnlyPlanDigest({
        ...original,
        origin: {
          ...original.origin,
          capturedDescription: { ...original.origin.capturedDescription, sha256: "d".repeat(64) },
        },
      }),
    ).not.toBe(nativeTargetAuthOnlyPlanDigest(original));
  });

  it("rejects unbound ownership, shared Auth resources, and roles absent from config", () => {
    expect(() => makePlan({ selectedProfile: { ...profile, appId: "other-app" } })).toThrow(
      "native_target_auth_only_resource_mismatch",
    );
    expect(() => makePlan({ selectedProfile: { ...profile, id: "different-profile" } })).toThrow(
      "native_target_auth_only_resource_mismatch",
    );
    expect(() =>
      makePlan({
        selectedProfile: {
          ...profile,
          authority: { ...owner.authority, ownerUserId: "another-owner" },
        },
      }),
    ).toThrow("native_target_auth_only_resource_mismatch");
    expect(() =>
      makePlan({ sharedAuthResourceId: profile.configuration.authDatabase.resourceId }),
    ).toThrow("native_target_auth_only_resource_mismatch");
    expect(() => makePlan({ configuredAppRoles: [] })).toThrow(
      "native_target_auth_only_resource_mismatch",
    );
    expect(() => makePlan({ selectedPhysicalEndpointId: "shared-endpoint" })).toThrow(
      "native_target_auth_only_resource_mismatch",
    );
    expect(() => makePlan({ proposal: { ...proposal, appRole: "unknown_role" } })).toThrow(
      "native_target_auth_only_resource_mismatch",
    );
  });

  it("loads the captured static description and selected Auth profile from owner-scoped ports", async () => {
    const reads: string[] = [];
    const planned = await planNativeTargetAuthOnlyFromOwnedState({
      owner,
      proposal,
      sharedAuthResourceId: "shared-auth-resource",
      sharedPhysicalEndpointId: "shared-endpoint",
      selectedPhysicalEndpointId: "isolated-endpoint",
      authAuthorityBinding,
      readCapturedDescription: async (input) => {
        reads.push(`description:${input.appId}:${input.appSpecDigest}:${input.publicSessionId}`);
        return description;
      },
      readAuthProfile: async (input) => {
        reads.push(`profile:${input.appId}:${input.profileId}:${input.authority.ownerUserId}`);
        return profile;
      },
      readConfiguredAppRoles: async (input) => {
        reads.push(`roles:${input.appId}:${input.profileId}`);
        return ["pilot_user"];
      },
      readPublishedSource: async (input) => {
        reads.push(`published:${input.appId}:${input.appSpecDigest}:${input.publicSessionId}`);
        return { branch: "main", changeSetDigest: "c".repeat(64), gitSha: "d".repeat(40), gitTree: "e".repeat(40), repositoryId: "repo_fixture", reviewDigest: "f".repeat(64) };
      },
      readAuthSchemaSelection: async (input) => {
        reads.push(`auth-schema:${input.appId}:${input.appSpecDigest}:${input.publicSessionId}`);
        return { artifactRef: "auth-artifact", planDigest: "1".repeat(64), targetDigest: "2".repeat(64), installer: { reference: "auth-worker", sha256: "3".repeat(64) } };
      },
    });
    expect(planned.authResource.resourceId).toBe("isolated-auth-resource");
    expect(reads).toContain(`description:signup-reset-pilot:${"a".repeat(64)}:public_original`);
    expect(reads).toContain(`profile:signup-reset-pilot:${profile.id}:owner_fixture`);
    expect(reads).toContain(`roles:signup-reset-pilot:${profile.id}`);
    expect(reads).toContain(`auth-schema:signup-reset-pilot:${"a".repeat(64)}:public_original`);
  });
});
