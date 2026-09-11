import { describe, expect, it } from "vitest";

import {
  auditAppliedAppComposition,
  bindArrustedComponentCompositionPolicy,
} from "./component-composition-policy";

const manifest = JSON.stringify({
  kind: "arrusted-component-composition-v1",
  providers: ["@autograph/components/providers"],
  publicImports: [
    "@autograph/components",
    "@autograph/compositions",
    "@autograph/icons",
  ],
  routeGlue: {
    allowedFiles: ["app/layout.tsx", "app/page.tsx"],
    allowedStyleFiles: [],
  },
  tokenEntrypoints: ["@autograph/design-system/tokens.css"],
  version: 1,
});

function binding() {
  const result = bindArrustedComponentCompositionPolicy({
    content: manifest,
    sourceSha: "a".repeat(40),
    sourceTree: "b".repeat(40),
  });
  if (result.status !== "available") {
    throw new Error("Expected policy binding.");
  }
  return result.binding;
}

describe("Arrusted component composition policy", () => {
  it("binds the target-owned manifest to the exact selected source", () => {
    expect(binding()).toMatchObject({
      policy: { kind: "arrusted-component-composition-v1" },
      sourceSha: "a".repeat(40),
      sourceTree: "b".repeat(40),
    });
  });

  it("reports a missing or malformed policy as unavailable", () => {
    expect(
      bindArrustedComponentCompositionPolicy({
        content: null,
        sourceSha: "a".repeat(40),
        sourceTree: "b".repeat(40),
      })
    ).toMatchObject({ status: "unavailable" });
    expect(
      bindArrustedComponentCompositionPolicy({
        content: "{",
        sourceSha: "a".repeat(40),
        sourceTree: "b".repeat(40),
      })
    ).toMatchObject({ status: "unavailable" });
  });

  it("accepts supported public composition and route glue", () => {
    expect(
      auditAppliedAppComposition({
        appId: "vendor-onboarding",
        binding: binding(),
        files: [
          {
            content:
              'import { KpiCard } from "@autograph/components";\nimport { Check } from "@autograph/icons";\nimport "@autograph/design-system/tokens.css";\nexport default function Page() { return <KpiCard icon={Check} title="Ready" value={3} />; }\n',
            path: "apps/vendor-onboarding/app/page.tsx",
          },
        ],
      })
    ).toMatchObject({ status: "passed" });
  });

  it.each([
    [
      "unapproved import",
      "apps/vendor-onboarding/app/page.tsx",
      'import { Card } from "@autograph/private";\nexport default function Page() { return <Card />; }\n',
      "unapproved-public-import",
    ],
    [
      "local component",
      "apps/vendor-onboarding/components/card.tsx",
      "export function Card() { return <div />; }\n",
      "local-component-file",
    ],
    [
      "replacement token",
      "apps/vendor-onboarding/app/custom.css",
      ":root { --brand: red; }\n",
      "replacement-design-token",
    ],
  ])("rejects %s", (_name, path, content, code) => {
    const result = auditAppliedAppComposition({
      appId: "vendor-onboarding",
      binding: binding(),
      files: [{ content, path }],
    });
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.violations.map((violation) => violation.code)).toContain(
        code
      );
    }
  });
});
