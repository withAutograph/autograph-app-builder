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
    appId: "signup-reset-pilot",
    appRole: "pilot_user",
    authResource: {
      authorityDigest: "b".repeat(64),
      database: "auth_identity",
      endpointId: "isolated-endpoint",
      hostname: "auth-preview.neon.tech",
      profileId: "signup-reset-pilot-preview-auth",
      resourceId: "isolated-auth-resource",
    },
    authSchema: {
      artifactRef: "auth-artifact",
      installer: { reference: "auth-worker", sha256: "3".repeat(64) },
      planDigest: "1".repeat(64),
      targetDigest: "2".repeat(64),
    },
    branch: "main",
    cost: { description: "Isolated Preview Auth only", ownership: "current-owner" },
    kind: "native-target-auth-only",
    origin: {
      adapterGeneration: 1,
      adapterSessionId: "native_original",
      appSpecDigest: "a".repeat(64),
      authority: {
        audience: "https://builder.example/mcp",
        issuer: "https://builder.example/api/auth",
        ownerUserId: "owner_fixture",
        workspaceId: "workspace_fixture",
      },
      capturedDescription,
      publicSessionId: "public_original",
    },
    project: {
      installationId: "install_fixture",
      name: "signup-reset-pilot",
      projectSettings: {
        framework: "nextjs",
        rootDirectory: "apps/signup-reset-pilot",
        sourceFilesOutsideRootDirectory: true,
      },
      protection: nativeTargetRequiredProjectProtection,
      teamId: "team_fixture",
    },
    publishedSource: {
      branch: "main",
      changeSetDigest: "c".repeat(64),
      gitSha: "d".repeat(40),
      gitTree: "e".repeat(40),
      repositoryId: "repo_fixture",
      reviewDigest: "f".repeat(64),
    },
    retention: { policy: "Retain until explicit approved cleanup" },
    signupPolicy: { eligibility: "approved-email-list", requireVerifiedEmail: true },
    version: 1,
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
          authorization: "declared-policy",
          kind: "generated-postgres",
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
