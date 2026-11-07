import { describe, expect, it } from "vitest";

import {
  capturedStaticDescriptionProvenance,
  nativeTargetAuthOnlyPlanDigest,
  nativeTargetAuthOnlyPlanSchema,
} from "./native-target-auth-only-plan-schema";
import { nativeTargetRequiredProjectProtection } from "./native-target-onboarding-plan-schema";

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
const capturedDescription = capturedStaticDescriptionProvenance(description);
const plan = () =>
  nativeTargetAuthOnlyPlanSchema.parse({
    version: 1,
    kind: "native-target-auth-only",
    appId: "signup-reset-pilot",
    origin: {
      authority: {
        issuer: "https://builder.example/api/auth",
        audience: "https://builder.example/mcp",
        workspaceId: "workspace_fixture",
        ownerUserId: "owner_fixture",
      },
      publicSessionId: "public_original",
      adapterSessionId: "native_original",
      adapterGeneration: 1,
      appSpecDigest: "a".repeat(64),
      capturedDescription,
    },
    project: {
      name: "signup-reset-pilot",
      teamId: "team_fixture",
      installationId: "install_fixture",
      projectSettings: {
        framework: "nextjs",
        rootDirectory: "apps/signup-reset-pilot",
        sourceFilesOutsideRootDirectory: true,
      },
      protection: nativeTargetRequiredProjectProtection,
    },
    branch: "main",
    publishedSource: {
      branch: "main",
      changeSetDigest: "c".repeat(64),
      gitSha: "d".repeat(40),
      gitTree: "e".repeat(40),
      repositoryId: "repo_fixture",
      reviewDigest: "f".repeat(64),
    },
    authResource: {
      profileId: "signup-reset-pilot-preview-auth",
      authorityDigest: "b".repeat(64),
      resourceId: "isolated-auth-resource",
      database: "auth_identity",
      endpointId: "isolated-endpoint",
      hostname: "auth-preview.neon.tech",
    },
    authSchema: {
      artifactRef: "auth-artifact",
      planDigest: "1".repeat(64),
      targetDigest: "2".repeat(64),
      installer: { reference: "auth-worker", sha256: "3".repeat(64) },
    },
    appRole: "pilot_user",
    signupPolicy: { eligibility: "approved-email-list", requireVerifiedEmail: true },
    cost: { ownership: "current-owner", description: "Isolated Preview Auth only" },
    retention: { policy: "Retain until explicit approved cleanup" },
  });
export const nativeTargetAuthOnlyTestPlan = () => plan();

describe("native Auth-only plan contract", () => {
  it("binds a captured static description and isolated Auth resource without app data fields", () => {
    const selected = plan();
    expect(selected.origin.capturedDescription.sha256).toBe(capturedDescription.sha256);
    expect(selected.authResource.resourceId).toBe("isolated-auth-resource");
    expect(selected.appRole).toBe("pilot_user");
    expect(selected).not.toHaveProperty("appDatabase");
    expect(selected).not.toHaveProperty("nativeNeon");
    expect(selected).not.toHaveProperty("worker");
  });

  it("requires a static description for the same app and rejects privileged or empty roles", () => {
    expect(() =>
      capturedStaticDescriptionProvenance({
        ...description,
        backend: {
          kind: "generated-postgres",
          authorization: "declared-policy",
          release: { artifactHash: "sha256:abc", directory: "release", id: "release-id" },
          roles: [],
          runtime: { databaseEnvironment: "DATABASE_URL" },
        },
      }),
    ).toThrow("Auth-only onboarding requires a captured static AppDescription.");
    expect(nativeTargetAuthOnlyPlanSchema.safeParse({ ...plan(), appRole: "admin" }).success).toBe(
      false,
    );
    expect(nativeTargetAuthOnlyPlanSchema.safeParse({ ...plan(), appRole: "" }).success).toBe(
      false,
    );
    expect(
      nativeTargetAuthOnlyPlanSchema.safeParse({
        ...plan(),
        origin: {
          ...plan().origin,
          capturedDescription: { ...capturedDescription, kind: "generated-postgres" },
        },
      }).success,
    ).toBe(false);
    expect(
      nativeTargetAuthOnlyPlanSchema.safeParse({
        ...plan(),
        origin: {
          ...plan().origin,
          capturedDescription: { ...capturedDescription, appId: "other-app" },
        },
      }).success,
    ).toBe(false);
  });

  it("binds approval-ready Auth policy and source identity in the semantic plan digest", () => {
    const selected = plan();
    expect(nativeTargetAuthOnlyPlanDigest(selected)).not.toBe(
      nativeTargetAuthOnlyPlanDigest({ ...selected, appRole: "pilot_viewer" }),
    );
    expect(
      nativeTargetAuthOnlyPlanDigest({
        ...selected,
        authResource: { ...selected.authResource, resourceId: "different-resource" },
      }),
    ).not.toBe(nativeTargetAuthOnlyPlanDigest(selected));
    expect(
      nativeTargetAuthOnlyPlanDigest({
        ...selected,
        origin: {
          ...selected.origin,
          capturedDescription: { ...selected.origin.capturedDescription, sha256: "c".repeat(64) },
        },
      }),
    ).not.toBe(nativeTargetAuthOnlyPlanDigest(selected));
  });
});
