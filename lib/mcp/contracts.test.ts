import { describe, expect, it } from "vitest";

import {
  eveRespondInputSchema,
  publicImplementationPlanSchema,
  publicPrototypeSchema,
} from "./contracts";

const response = (requestId: string) => ({
  requestId,
  response: { kind: "approve" as const },
});

describe("eveRespondInputSchema", () => {
  it("accepts only one non-empty unique response batch", () => {
    expect(
      eveRespondInputSchema
        .parse({
          sessionId: "session_1",
          clientRequestId: "client_1",
          responses: [response("one"), response("two"), response("three")],
        })
        .responses.map(({ requestId }) => requestId),
    ).toEqual(["one", "two", "three"]);
    expect(() =>
      eveRespondInputSchema.parse({
        sessionId: "session_1",
        clientRequestId: "client_1",
        requestId: "legacy",
        response: { kind: "approve" },
      }),
    ).toThrow();
    expect(() =>
      eveRespondInputSchema.parse({
        sessionId: "session_1",
        clientRequestId: "client_1",
        responses: [],
      }),
    ).toThrow();
    const duplicate = eveRespondInputSchema.safeParse({
      sessionId: "session_1",
      clientRequestId: "client_1",
      responses: [response("same"), response("same")],
    });
    expect(duplicate.success).toBe(false);
    if (!duplicate.success)
      expect(duplicate.error.issues).toContainEqual(
        expect.objectContaining({
          path: ["responses", 1, "requestId"],
          message: "Each requestId must appear exactly once.",
        }),
      );
  });
});

describe("publicPrototypeSchema", () => {
  const prototype = {
    path: "prototype/vendor-onboarding/index.html",
    mediaType: "text/html" as const,
    content: "<!doctype html><html><body>Vendor queue</body></html>",
    digest: "a".repeat(64),
    revision: "b".repeat(64),
  };

  it("accepts only the closed bounded HTML delivery shape", () => {
    expect(publicPrototypeSchema.parse(prototype)).toEqual(prototype);
    expect(
      publicPrototypeSchema.safeParse({ ...prototype, internalPath: "/tmp" })
        .success,
    ).toBe(false);
    expect(
      publicPrototypeSchema.safeParse({
        ...prototype,
        path: "prototype/vendor-onboarding/app-spec.md",
      }).success,
    ).toBe(false);
    expect(
      publicPrototypeSchema.safeParse({
        ...prototype,
        content: "é".repeat(131_073),
      }).success,
    ).toBe(false);
  });
});

describe("publicImplementationPlanSchema", () => {
  const plan = {
    appId: "vendor-onboarding",
    runtime: "nextjs" as const,
    workspacePath: "apps/vendor-onboarding",
    packageName: "@autograph/vendor-onboarding",
    projectName: "apps-vendor-onboarding",
    routes: ["/vendor-onboarding", "/vendor-onboarding/:path*"],
    sourceSha: "a".repeat(40),
    sourceTree: "b".repeat(40),
    proposalDigest: "c".repeat(64),
    readOnly: true as const,
  };

  it("accepts only the closed sanitized target-plan shape", () => {
    expect(publicImplementationPlanSchema.parse(plan)).toEqual(plan);
    expect(
      publicImplementationPlanSchema.safeParse({
        ...plan,
        internalAppSpec: "private",
      }).success,
    ).toBe(false);
    expect(
      publicImplementationPlanSchema.safeParse({
        ...plan,
        sourceSha: "d".repeat(64),
      }).success,
    ).toBe(false);
    expect(
      publicImplementationPlanSchema.safeParse({
        ...plan,
        workspacePath: "../outside",
      }).success,
    ).toBe(false);
  });
});
