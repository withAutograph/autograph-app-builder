import { describe, expect, it } from "vitest";
import { hostedOperatorSourceConfigurationSchema } from "./hosted-operator-source-configuration";

const application = () => ({
  accessRoles: ["member"],
  appDatabase: {
    database: "app",
    migratorRole: "app_owner",
    resourceId: "app-resource",
    runtimeRole: "app_runtime",
  },
  branch: "feature/actual-publication",
  projectId: "prj_actual_app",
});
const { applications } = hostedOperatorSourceConfigurationSchema.shape;

describe("deployment-owned app publication configuration", () => {
  it("accepts an app before publication without inventing a repository or commit", () => {
    const parsed = applications.parse({ actual: application() });
    expect(parsed.actual).toEqual(application());
    expect(parsed.actual?.repoId).toBeUndefined();
    expect(parsed.actual?.gitSha).toBeUndefined();
  });

  it("preserves the exact actual publication binding when it is available", () => {
    const actual = { ...application(), gitSha: "b".repeat(40), repoId: "actual-repository-id" };
    expect(applications.parse({ actual }).actual).toEqual(actual);
  });

  it("accepts trusted source-derived native project settings without inventing app paths", () => {
    const projectSettings = {
      framework: "nextjs",
      rootDirectory: "apps/actual-app",
      sourceFilesOutsideRootDirectory: true,
    };
    const parsed = applications.parse({ actual: { ...application(), projectSettings } });
    expect(parsed.actual?.projectSettings).toEqual(projectSettings);
  });

  it.each(["bun run build", "npm run build", null])(
    "preserves an explicitly configured build command without choosing a runner: %s",
    (buildCommand) => {
      const projectSettings = {
        buildCommand,
        framework: "nextjs",
        rootDirectory: "apps/actual-app",
        sourceFilesOutsideRootDirectory: true,
      };
      const parsed = applications.parse({ actual: { ...application(), projectSettings } });
      expect(parsed.actual?.projectSettings).toEqual(projectSettings);
    },
  );

  it.each(["branch", "projectId", "appDatabase"] as const)(
    "still requires the app's actual %s",
    (field) => {
      const { [field]: omitted, ...actual } = application();
      void omitted;
      expect(applications.safeParse({ actual }).success).toBe(false);
    },
  );

  it.each([{ repoId: "" }, { gitSha: "not-a-commit" }])(
    "rejects a malformed supplied publication binding: %j",
    (binding) => {
      expect(applications.safeParse({ actual: { ...application(), ...binding } }).success).toBe(
        false,
      );
    },
  );

  it.each(["repoId", "gitSha"] as const)("keeps Gateway publication %s required", (field) => {
    const gateway = {
      authBrowserOrigin: "https://auth.example",
      branch: "gateway-actual",
      environment: "preview",
      gatewayOrigin: "https://gateway.example",
      gitSha: "c".repeat(40),
      projectId: "prj_actual_gateway",
      protectedApplicationIds: ["actual"],
      publicOrigin: "https://apps.example",
      repoId: "actual-gateway-repository-id",
      workload: {
        audience: "https://vercel.com/team",
        environment: "preview",
        issuer: "https://oidc.vercel.com/team",
        ownerId: "team",
        projectId: "prj_actual_gateway",
        subject: "gateway-workload",
      },
    };
    const schema = hostedOperatorSourceConfigurationSchema.shape.gateway;
    expect(schema.safeParse(gateway).success).toBe(true);
    const { [field]: omitted, ...incomplete } = gateway;
    void omitted;
    expect(schema.safeParse(incomplete).success).toBe(false);
  });
});
