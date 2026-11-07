import { describe, expect, it } from "vitest";

import {
  nativeTargetAuthOnlyPlanDigest,
  nativeTargetAuthOnlySchemaEffectDigest,
} from "./native-target-auth-only-plan-schema";
import {
  planNativeTargetAuthOnly,
  planNativeTargetAuthOnlyFromOwnedState,
} from "./native-target-auth-only-planner";
import { nativeTargetRequiredProjectProtection } from "./native-target-onboarding-plan-schema";

const owner = {
  adapterGeneration: 1,
  adapterSessionId: "native_original",
  authority: {
    audience: "https://builder.example/mcp",
    issuer: "https://builder.example/api/auth",
    ownerUserId: "owner_fixture",
    workspaceId: "workspace_fixture",
  },
  publicSessionId: "public_original",
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
  appId: "signup-reset-pilot",
  authority: owner.authority,
  configuration: {
    authDatabase: {
      database: "auth_identity",
      migratorRole: "auth_migrator",
      resourceId: "isolated-auth-resource",
      runtimeRole: "auth_runtime",
    },
  },
  id: "signup-reset-pilot-preview-auth",
};
const authAuthorityBinding = {
  gateway: { branch: "preview-fixture", projectId: "gateway-fixture" },
  nativeNeon: { scope: { endpointId: "isolated-endpoint", hostname: "auth-preview.neon.tech" } },
};
const proposal = {
  appId: "signup-reset-pilot",
  appRole: "pilot_user",
  appSpecDigest: "a".repeat(64),
  authProfileId: profile.id,
  branch: "main",
  project: {
    installationId: "install_fixture",
    name: "signup-reset-pilot",
    teamId: "team_fixture",
  },
};
const makePlan = (overrides: Partial<Parameters<typeof planNativeTargetAuthOnly>[0]> = {}) =>
  planNativeTargetAuthOnly({
    authAuthorityBinding,
    authSchema: {
      artifactRef: "auth-artifact",
      installer: { reference: "auth-worker", sha256: "3".repeat(64) },
      planDigest: "1".repeat(64),
      targetDigest: "2".repeat(64),
    },
    capturedDescription: description,
    configuredAppRoles: ["pilot_user"],
    owner,
    proposal,
    publishedSource: {
      branch: "main",
      changeSetDigest: "c".repeat(64),
      gitSha: "d".repeat(40),
      gitTree: "e".repeat(40),
      repositoryId: "repo_fixture",
      reviewDigest: "f".repeat(64),
    },
    selectedPhysicalEndpointId: "isolated-endpoint",
    selectedProfile: profile,
    sharedAuthResourceId: "shared-auth-resource",
    sharedPhysicalEndpointId: "shared-endpoint",
    ...overrides,
  });

describe("native Auth-only planning", () => {
  it("binds schema approval to the exact published source, resource, role, and policy", () => {
    const plan = makePlan();
    const source = plan.publishedSource;
    const original = nativeTargetAuthOnlySchemaEffectDigest(plan, source);
    expect(
      nativeTargetAuthOnlySchemaEffectDigest(plan, { ...source, gitSha: "1".repeat(40) }),
    ).not.toBe(original);
    expect(
      nativeTargetAuthOnlySchemaEffectDigest({ ...plan, appRole: "pilot_reviewer" }, source),
    ).not.toBe(original);
    expect(
      nativeTargetAuthOnlySchemaEffectDigest(
        { ...plan, authResource: { ...plan.authResource, resourceId: "different-auth-resource" } },
        source,
      ),
    ).not.toBe(original);
    expect(
      nativeTargetAuthOnlySchemaEffectDigest(
        { ...plan, authSchema: { ...plan.authSchema, artifactRef: "different-auth-artifact" } },
        source,
      ),
    ).not.toBe(original);
  });

  it("plans from captured static source and owner-bound isolated Auth profile", () => {
    const plan = makePlan();
    expect(plan).toMatchObject({
      appId: "signup-reset-pilot",
      appRole: "pilot_user",
      authResource: {
        profileId: profile.id,
        resourceId: profile.configuration.authDatabase.resourceId,
      },
      project: {
        projectSettings: {
          framework: "nextjs",
          rootDirectory: "apps/signup-reset-pilot",
          sourceFilesOutsideRootDirectory: true,
        },
        protection: nativeTargetRequiredProjectProtection,
      },
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
      authAuthorityBinding,
      owner,
      proposal,
      readAuthProfile: (input) => {
        reads.push(`profile:${input.appId}:${input.profileId}:${input.authority.ownerUserId}`);
        return Promise.resolve(profile);
      },
      readAuthSchemaSelection: (input) => {
        reads.push(`auth-schema:${input.appId}:${input.appSpecDigest}:${input.publicSessionId}`);
        return Promise.resolve({
          artifactRef: "auth-artifact",
          planDigest: "1".repeat(64),
          targetDigest: "2".repeat(64),
          installer: { reference: "auth-worker", sha256: "3".repeat(64) },
        });
      },
      readCapturedDescription: (input) => {
        reads.push(`description:${input.appId}:${input.appSpecDigest}:${input.publicSessionId}`);
        return Promise.resolve(description);
      },
      readConfiguredAppRoles: (input) => {
        reads.push(`roles:${input.appId}:${input.profileId}`);
        return Promise.resolve(["pilot_user"]);
      },
      readPublishedSource: (input) => {
        reads.push(`published:${input.appId}:${input.appSpecDigest}:${input.publicSessionId}`);
        return Promise.resolve({
          branch: "main",
          changeSetDigest: "c".repeat(64),
          gitSha: "d".repeat(40),
          gitTree: "e".repeat(40),
          repositoryId: "repo_fixture",
          reviewDigest: "f".repeat(64),
        });
      },
      selectedPhysicalEndpointId: "isolated-endpoint",
      sharedAuthResourceId: "shared-auth-resource",
      sharedPhysicalEndpointId: "shared-endpoint",
    });
    expect(planned.authResource.resourceId).toBe("isolated-auth-resource");
    expect(reads).toContain(`description:signup-reset-pilot:${"a".repeat(64)}:public_original`);
    expect(reads).toContain(`profile:signup-reset-pilot:${profile.id}:owner_fixture`);
    expect(reads).toContain(`roles:signup-reset-pilot:${profile.id}`);
    expect(reads).toContain(`auth-schema:signup-reset-pilot:${"a".repeat(64)}:public_original`);
  });
});
