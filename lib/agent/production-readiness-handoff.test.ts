import { describe, expect, it } from "vitest";

import { productionReadinessHandoff } from "./production-readiness-handoff";

const root = "repository";
const app = "spend-review";
const release = "2026-09-29.production-pilot-v13";
const handoffContract = (roles: string[]) => ({
  appId: app,
  coreRoute: `/${app}`,
  operatorGuide: "docs/operations/generated-app-production.md",
  roles,
  schemaReceiptPath: `/${app}/api/schema`,
  version: 1,
});
const files = new Map<string, string>([
  [`${root}/apps/${app}/schema/index.ts`, `export * from "./release/${release}/data-server";\n`],
  [
    `${root}/apps/${app}/schema/release/${release}/release-manifest.json`,
    JSON.stringify({
      app,
      hashes: { schema: `sha256:${"a".repeat(64)}` },
      schema_version: release,
    }),
  ],
  [
    `${root}/apps/${app}/.config/production-handoff.json`,
    JSON.stringify({
      appId: app,
      coreRoute: `/${app}`,
      operatorGuide: "docs/operations/generated-app-production.md",
      roles: ["member", "reviewer"],
      schemaReceiptPath: `/${app}/api/schema`,
      version: 1,
    }),
  ],
  [`${root}/.config/mise/config.toml`, '[tasks."app:production"]\nrun = "..."'],
]);

const source = (overrides: Map<string, string> = files) => ({
  readTextFile: async ({ path }: { path: string }) =>
    await Promise.resolve(overrides.get(path) ?? null),
});

describe("productionReadinessHandoff", () => {
  it("reports the exact checked release and operator path without claiming Production readiness", async () => {
    const result = await productionReadinessHandoff({
      appId: app,
      repositoryRoot: root,
      source: source(),
    });
    expect(result).toMatchObject({
      appId: app,
      blockers: [],
      checkedRelease: { artifactHash: `sha256:${"a".repeat(64)}`, releaseId: release },
      operatorTask: "mise run app:production -- plan",
      roles: ["member", "reviewer"],
      route: `/${app}`,
      schemaReceiptPath: `/${app}/api/schema`,
      status: "operator-review-required",
    });
  });

  it.each([20, 21, 100])(
    "retains all %i declared roles without a workload ceiling",
    async (count) => {
      const changed = new Map(files);
      const path = `${root}/apps/${app}/.config/production-handoff.json`;
      const roles = Array.from({ length: count }, (_, index) => `role_${index}`);
      changed.set(path, JSON.stringify(handoffContract(roles)));
      const result = await productionReadinessHandoff({
        appId: app,
        repositoryRoot: root,
        source: source(changed),
      });
      expect(result.roles).toEqual(roles);
      expect(result.blockers).toEqual([]);
      expect(result.status).toBe("operator-review-required");
    },
  );

  it("still rejects invalid role identifiers without failing private validation", async () => {
    const changed = new Map(files);
    const path = `${root}/apps/${app}/.config/production-handoff.json`;
    changed.set(path, JSON.stringify(handoffContract(["../invalid"])));
    const result = await productionReadinessHandoff({
      appId: app,
      repositoryRoot: root,
      source: source(changed),
    });
    expect(result.roles).toEqual([]);
    expect(result.blockers).toContain("The app-owned Production handoff contract needs review.");
  });

  it("surfaces missing operator contracts as blockers", async () => {
    const result = await productionReadinessHandoff({
      appId: app,
      repositoryRoot: root,
      source: source(new Map()),
    });
    expect(result.checkedRelease).toBeNull();
    expect(result.blockers).toHaveLength(3);
  });

  it("keeps repository validation intact when a sandbox has no file reader", async () => {
    const result = await productionReadinessHandoff({
      appId: app,
      repositoryRoot: root,
      source: {},
    });
    expect(result.checkedRelease).toBeNull();
    expect(result.blockers).toHaveLength(3);
  });

  it("blocks a manifest for another app without failing repository validation", async () => {
    const changed = new Map(files);
    changed.set(
      `${root}/apps/${app}/schema/release/${release}/release-manifest.json`,
      JSON.stringify({
        app: "other-app",
        hashes: { schema: `sha256:${"a".repeat(64)}` },
        schema_version: release,
      }),
    );
    const result = await productionReadinessHandoff({
      appId: app,
      repositoryRoot: root,
      source: source(changed),
    });
    expect(result.checkedRelease).toBeNull();
    expect(result.blockers).toContain(
      "The checked release pointer and manifest need review before Production preparation.",
    );
  });
});
