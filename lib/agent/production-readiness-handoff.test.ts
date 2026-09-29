import { describe, expect, it } from "vitest";

import { productionReadinessHandoff } from "./production-readiness-handoff";

const root = "repository";
const app = "spend-review";
const release = "2026-09-29.production-pilot-v13";
const files = new Map<string, string>([
  [`${root}/apps/${app}/schema/index.ts`, `export * from "./release/${release}/data-server";\n`],
  [
    `${root}/apps/${app}/schema/release/${release}/release-manifest.json`,
    JSON.stringify({
      app,
      schema_version: release,
      hashes: { schema: `sha256:${"a".repeat(64)}` },
    }),
  ],
  [
    `${root}/apps/${app}/.config/production-handoff.json`,
    JSON.stringify({
      version: 1,
      appId: app,
      coreRoute: `/${app}`,
      schemaReceiptPath: `/${app}/api/schema`,
      roles: ["member", "reviewer"],
      operatorGuide: "docs/operations/generated-app-production.md",
    }),
  ],
  [`${root}/.config/mise/config.toml`, '[tasks."app:production"]\nrun = "..."'],
]);

const source = (overrides: Map<string, string> = files) => ({
  readTextFile: async ({ path }: { path: string }) => overrides.get(path) ?? null,
});

describe("productionReadinessHandoff", () => {
  it("reports the exact checked release and operator path without claiming Production readiness", async () => {
    const result = await productionReadinessHandoff({
      appId: app,
      repositoryRoot: root,
      source: source(),
    });
    expect(result).toMatchObject({
      status: "operator-review-required",
      appId: app,
      route: `/${app}`,
      checkedRelease: { releaseId: release, artifactHash: `sha256:${"a".repeat(64)}` },
      roles: ["member", "reviewer"],
      schemaReceiptPath: `/${app}/api/schema`,
      operatorTask: "mise run app:production -- plan",
      blockers: [],
    });
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

  it("blocks a manifest for another app without failing repository validation", async () => {
    const changed = new Map(files);
    changed.set(
      `${root}/apps/${app}/schema/release/${release}/release-manifest.json`,
      JSON.stringify({
        app: "other-app",
        schema_version: release,
        hashes: { schema: `sha256:${"a".repeat(64)}` },
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
