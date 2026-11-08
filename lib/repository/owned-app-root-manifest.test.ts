import { describe, expect, it } from "vitest";
import { z } from "zod";

import { planOwnedAppRootManifest } from "./owned-app-root-manifest";

type FixtureValue = z.infer<ReturnType<typeof z.json>> | undefined;
interface ManifestFixture {
  [key: string]: FixtureValue;
}
const resultSchema = z.record(z.string(), z.json());
const unavailableCatalogs: FixtureValue[] = [
  undefined,
  null,
  [],
  "invalid",
  {},
  { needed: 7 },
  { needed: "" },
];

const manifest = (value: ManifestFixture) => `${JSON.stringify(value, null, 2)}\n`;
const plan = (
  base: ManifestFixture,
  originalPublished: ManifestFixture = {},
  appManifest: ManifestFixture = {},
) =>
  resultSchema.parse(
    JSON.parse(
      planOwnedAppRootManifest({
        appId: "request-log",
        base: manifest(base),
        originalPublished: manifest(originalPublished),
        appManifest: manifest(appManifest),
      }),
    ),
  );

describe("owned app root manifest planning", () => {
  it("retains exact current bytes when existing workspace and catalog already cover the app", () => {
    const base =
      '{\r\n\t"custom": {"kept": true},\r\n\t"workspaces": ["apps/*", "packages/*"],\r\n\t"catalog": {"react": "current-version"}\r\n}\r\n';
    expect(
      planOwnedAppRootManifest({
        appId: "request-log",
        base,
        originalPublished: manifest({ catalog: { react: "older-version", unwanted: "old" } }),
        appManifest: manifest({ dependencies: { react: "catalog:" } }),
      }),
    ).toBe(base);
  });

  it("preserves unrelated workspace-object fields, consumers and catalogs when adding the app", () => {
    const base = {
      name: "arbitrary-existing-root",
      version: "unrelated-version",
      private: true,
      scripts: { check: "existing-check" },
      workspaces: { packages: ["packages/*", "apps/existing"], nohoist: ["retained"] },
      dependencies: { existing: "catalog:" },
      catalog: { existing: "base-version", react: "current-react" },
      catalogs: { separate: { retained: "separate-version" } },
    };
    expect(
      plan(base, {
        name: "different-old-root",
        workspaces: ["apps/obsolete"],
        dependencies: { unwanted: "old" },
        catalog: { existing: "old-version", react: "old-react", unwanted: "old" },
      }),
    ).toEqual({
      ...base,
      workspaces: {
        ...base.workspaces,
        packages: [...base.workspaces.packages, "apps/request-log"],
      },
    });
  });

  it.each(["apps/*", "apps/**", "apps/{other,request-log}"])(
    "uses the current %s workspace glob without adding a redundant path",
    (pattern) => {
      const base = manifest({ workspaces: { packages: [pattern], retained: "value" } });
      expect(
        planOwnedAppRootManifest({
          appId: "request-log",
          base,
          originalPublished: "{}",
          appManifest: "{}",
        }),
      ).toBe(base);
    },
  );

  it("adds one explicit workspace when an existing array does not cover the app", () => {
    expect(plan({ workspaces: ["packages/*", "apps/existing"] })).toEqual({
      workspaces: ["packages/*", "apps/existing", "apps/request-log"],
    });
  });

  it("can establish workspace registration without requiring root name or version fields", () => {
    expect(plan({ scripts: { check: "existing-check" } })).toEqual({
      scripts: { check: "existing-check" },
      workspaces: ["apps/request-log"],
    });
  });

  it("copies only app-needed missing catalog entries across dependency sections", () => {
    const base = {
      workspaces: ["apps/*", "packages/*"],
      catalog: { react: "new-current-version", otherApp: "keep" },
      dependencies: { existing: "unchanged" },
    };
    expect(
      plan(
        base,
        {
          catalog: {
            react: "old-version",
            server: "server-value",
            tests: "test-value",
            optional: "optional-value",
            unused: "discard",
          },
        },
        {
          dependencies: { react: "catalog:", server: "catalog:", direct: "direct-value" },
          devDependencies: { tests: "catalog:" },
          peerDependencies: { server: "catalog:" },
          optionalDependencies: { optional: "catalog:" },
        },
      ),
    ).toEqual({
      ...base,
      catalog: {
        ...base.catalog,
        server: "server-value",
        tests: "test-value",
        optional: "optional-value",
      },
    });
  });

  it("creates a missing base catalog from only the selected app's required original value", () => {
    expect(
      plan(
        { workspaces: ["apps/*"] },
        { catalog: { needed: "workspace:*", unused: "other" } },
        { dependencies: { needed: "catalog:" } },
      ),
    ).toEqual({ workspaces: ["apps/*"], catalog: { needed: "workspace:*" } });
  });

  it.each(unavailableCatalogs)(
    "rejects an unresolved or malformed required published catalog without modifying its inputs (%j)",
    (catalog) => {
      const input = Object.freeze({
        appId: "request-log",
        base: manifest({ workspaces: ["packages/*"], catalog: { otherApp: "keep" } }),
        originalPublished: manifest({ catalog }),
        appManifest: manifest({ dependencies: { needed: "catalog:" } }),
      });
      const before = { ...input };
      expect(() => planOwnedAppRootManifest(input)).toThrow();
      expect(input).toEqual(before);
    },
  );

  it.each([null, [], "invalid", { existing: false }])(
    "rejects a malformed current base catalog rather than replacing unrelated values (%j)",
    (catalog) => {
      expect(() => plan({ workspaces: ["apps/*"], catalog })).toThrow();
    },
  );

  it("preserves an explicit current workspace exclusion instead of overriding it", () => {
    expect(() => plan({ workspaces: ["apps/*", "!apps/request-log"] })).toThrow("exclude");
  });

  it("rejects malformed workspace and app dependency declarations", () => {
    expect(() => plan({ workspaces: { packages: "apps/*" } })).toThrow();
    expect(() => plan({ workspaces: ["apps/*"] }, {}, { dependencies: null })).toThrow();
  });
});
