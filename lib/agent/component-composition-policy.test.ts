import { describe, expect, it } from "vitest";

import {
  auditAppliedAppComposition,
  bindArrustedComponentCompositionPolicy,
} from "./component-composition-policy";

const manifest = JSON.stringify({
  version: 1,
  kind: "arrusted-component-composition-v1",
  publicImports: ["@arrusted/ui/review-queue"],
  tokenEntrypoints: ["@arrusted/design-system/tokens.css"],
  providers: ["@arrusted/ui/provider"],
  routeGlue: {
    allowedFiles: ["app/layout.tsx", "app/page.tsx"],
    allowedStyleFiles: [],
  },
});

function binding() {
  const result = bindArrustedComponentCompositionPolicy({
    content: manifest,
    sourceSha: "a".repeat(40),
    sourceTree: "b".repeat(40),
  });
  if (result.status !== "available")
    throw new Error("Expected policy binding.");
  return result.binding;
}

describe("Arrusted component composition policy", () => {
  it("binds the target-owned manifest to the exact selected source", () => {
    expect(binding()).toMatchObject({
      sourceSha: "a".repeat(40),
      sourceTree: "b".repeat(40),
      policy: { kind: "arrusted-component-composition-v1" },
    });
  });

  it("reports a missing or malformed policy as unavailable", () => {
    expect(
      bindArrustedComponentCompositionPolicy({
        content: null,
        sourceSha: "a".repeat(40),
        sourceTree: "b".repeat(40),
      }),
    ).toMatchObject({ status: "unavailable" });
    expect(
      bindArrustedComponentCompositionPolicy({
        content: "{",
        sourceSha: "a".repeat(40),
        sourceTree: "b".repeat(40),
      }),
    ).toMatchObject({ status: "unavailable" });
  });

  it("accepts supported public composition and route glue", () => {
    expect(
      auditAppliedAppComposition({
        appId: "vendor-onboarding",
        binding: binding(),
        files: [
          {
            path: "apps/vendor-onboarding/app/page.tsx",
            content:
              'import { ReviewQueue } from "@arrusted/ui/review-queue";\nimport "@arrusted/design-system/tokens.css";\nexport default function Page() { return <ReviewQueue />; }\n',
          },
        ],
      }),
    ).toMatchObject({ status: "passed" });
  });

  it.each([
    [
      "unapproved import",
      "apps/vendor-onboarding/app/page.tsx",
      'import { Card } from "@arrusted/ui/card";\nexport default function Page() { return <Card />; }\n',
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
      files: [{ path, content }],
    });
    expect(result.status).toBe("failed");
    if (result.status === "failed")
      expect(result.violations.map((violation) => violation.code)).toContain(
        code,
      );
  });
});
