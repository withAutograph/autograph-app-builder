import { describe, expect, it } from "vitest";

import {
  eveGetInputSchema,
  eveRespondInputSchema,
  eveStartInputSchema,
  publicInputRequestSchema,
  publicImplementationPlanSchema,
  publicPrototypeSchema,
} from "./contracts";

describe("durable session discovery contracts", () => {
  it("lists without a session and requires exactly one new, handoff, or resume start", () => {
    expect(eveGetInputSchema.parse({})).toEqual({ cursor: 0, limit: 100 });
    expect(
      eveStartInputSchema.parse({
        clientRequestId: "resume-one",
        resumeSessionId: "session-one",
      })
    ).toMatchObject({ resumeSessionId: "session-one" });
    expect(
      eveStartInputSchema.parse({
        clientRequestId: "handoff-one",
        handoffId: "123e4567-e89b-42d3-a456-426614174000",
      })
    ).toMatchObject({
      handoffId: "123e4567-e89b-42d3-a456-426614174000",
    });
    for (const candidate of [
      { clientRequestId: "missing" },
      {
        clientRequestId: "cannot-inject-internal-context",
        prompt: "Build",
        sourceHandoffId: "123e4567-e89b-42d3-a456-426614174000",
      },
      {
        clientRequestId: "both",
        prompt: "Build",
        resumeSessionId: "session-one",
      },
      {
        clientRequestId: "prompt-and-handoff",
        handoffId: "123e4567-e89b-42d3-a456-426614174000",
        prompt: "Build",
      },
    ]) {
      expect(eveStartInputSchema.safeParse(candidate).success).toBe(false);
    }
  });
});

describe("publicInputRequestSchema", () => {
  const authorization = {
    allowFreeform: false,
    kind: "authorization" as const,
    requestId: "authorize-one",
    title: "GitHub",
  };

  it("accepts only safe authorization challenges", () => {
    for (const url of [
      "https://github.com/login/oauth/authorize?state=opaque",
      "http://127.0.0.1:4000/callback",
    ]) {
      expect(
        publicInputRequestSchema.safeParse({
          ...authorization,
          authorization: { url, displayName: "GitHub" },
        }).success
      ).toBe(true);
    }

    for (const url of [
      "http://github.example/authorize",
      "https://user:secret@github.example/authorize",
      "javascript:alert(1)",
    ]) {
      expect(
        publicInputRequestSchema.safeParse({
          ...authorization,
          authorization: { url },
        }).success
      ).toBe(false);
    }
  });

  it("accepts closed GitHub repository-access presentation metadata", () => {
    const repositoryAccess = {
      action: "update" as const,
      provider: "github" as const,
      repository: {
        fullName: "withAutograph/app-builder-dogfood",
        name: "app-builder-dogfood",
        owner: "withAutograph",
      },
      scopes: [
        {
          installationId: "123",
          accountLogin: "withAutograph",
          accountType: "Organization" as const,
        },
      ],
    };
    expect(
      publicInputRequestSchema.safeParse({
        ...authorization,
        authorization: {
          displayName: "GitHub",
          repositoryAccess,
          url: "https://builder.example.test/github/installations?continuation=opaque",
        },
        title: "Update GitHub access",
      }).success
    ).toBe(true);
    expect(
      publicInputRequestSchema.safeParse({
        ...authorization,
        authorization: {
          repositoryAccess: { ...repositoryAccess, accessToken: "secret" },
        },
      }).success
    ).toBe(false);
  });

  it("keeps presentation metadata closed and authorization-specific", () => {
    expect(
      publicInputRequestSchema.safeParse({
        allowFreeform: false,
        kind: "question",
        presentation: { control: "provider", section: "store-in" },
        requestId: "choice-one",
        title: "Store in",
      }).success
    ).toBe(true);
    expect(
      publicInputRequestSchema.safeParse({
        allowFreeform: false,
        authorization: { url: "https://github.com" },
        kind: "question",
        requestId: "choice-one",
        title: "Store in",
      }).success
    ).toBe(false);
  });
});

const response = (requestId: string) => ({
  requestId,
  response: { kind: "approve" as const },
});

describe("eveRespondInputSchema", () => {
  it("accepts only one non-empty unique response batch", () => {
    expect(
      eveRespondInputSchema
        .parse({
          clientRequestId: "client_1",
          responses: [response("one"), response("two"), response("three")],
          sessionId: "session_1",
        })
        .responses.map(({ requestId }) => requestId)
    ).toEqual(["one", "two", "three"]);
    expect(() =>
      eveRespondInputSchema.parse({
        clientRequestId: "client_1",
        requestId: "legacy",
        response: { kind: "approve" },
        sessionId: "session_1",
      })
    ).toThrow();
    expect(() =>
      eveRespondInputSchema.parse({
        clientRequestId: "client_1",
        responses: [],
        sessionId: "session_1",
      })
    ).toThrow();
    const duplicate = eveRespondInputSchema.safeParse({
      clientRequestId: "client_1",
      responses: [response("same"), response("same")],
      sessionId: "session_1",
    });
    expect(duplicate.success).toBe(false);
    if (!duplicate.success) {
      expect(duplicate.error.issues).toContainEqual(
        expect.objectContaining({
          path: ["responses", 1, "requestId"],
          message: "Each requestId must appear exactly once.",
        })
      );
    }
  });
});

describe("publicPrototypeSchema", () => {
  const prototype = {
    content: "<!doctype html><html><body>Vendor queue</body></html>",
    digest: "a".repeat(64),
    mediaType: "text/html" as const,
    path: "prototype/vendor-onboarding/index.html",
    revision: "b".repeat(64),
  };

  it("accepts only the closed bounded HTML delivery shape", () => {
    expect(publicPrototypeSchema.parse(prototype)).toEqual(prototype);
    expect(
      publicPrototypeSchema.safeParse({ ...prototype, internalPath: "/tmp" })
        .success
    ).toBe(false);
    expect(
      publicPrototypeSchema.safeParse({
        ...prototype,
        path: "prototype/vendor-onboarding/app-spec.md",
      }).success
    ).toBe(false);
    expect(
      publicPrototypeSchema.safeParse({
        ...prototype,
        content: "é".repeat(4 * 1024 * 1024 + 1),
      }).success
    ).toBe(false);
  });

  it("accepts compiled component documents larger than the old HTML-only limit", () => {
    expect(
      publicPrototypeSchema.safeParse({
        ...prototype,
        content: "x".repeat(512_302),
      }).success
    ).toBe(true);
  });

  it("accepts only exact hosted HTTPS or loopback preview URLs", () => {
    const path = `/preview/session-one/${"a".repeat(64)}`;
    expect(
      publicPrototypeSchema.safeParse({
        ...prototype,
        previewUrl: `https://builder.example.test${path}`,
      }).success
    ).toBe(true);
    expect(
      publicPrototypeSchema.safeParse({
        ...prototype,
        previewUrl: `http://127.0.0.1:3000${path}`,
      }).success
    ).toBe(true);
    for (const previewUrl of [
      `http://builder.example.test${path}`,
      `data:text/html,${encodeURIComponent(prototype.content)}`,
      `https://user:secret@builder.example.test${path}`,
      `https://builder.example.test${path}?token=secret`,
      `https://builder.example.test/other/${"a".repeat(64)}`,
    ]) {
      expect(
        publicPrototypeSchema.safeParse({ ...prototype, previewUrl }).success
      ).toBe(false);
    }
  });
});

describe("publicImplementationPlanSchema", () => {
  const plan = {
    appId: "vendor-onboarding",
    packageName: "@autograph/vendor-onboarding",
    projectName: "apps-vendor-onboarding",
    readOnly: true as const,
    routes: ["/vendor-onboarding", "/vendor-onboarding/:path*"],
    runtime: "nextjs" as const,
  };

  it("accepts only the closed sanitized target-plan shape", () => {
    expect(publicImplementationPlanSchema.parse(plan)).toEqual(plan);
    expect(
      publicImplementationPlanSchema.safeParse({
        ...plan,
        internalAppSpec: "private",
      }).success
    ).toBe(false);
    expect(
      publicImplementationPlanSchema.safeParse({
        ...plan,
        sourceSha: "d".repeat(40),
      }).success
    ).toBe(false);
    expect(
      publicImplementationPlanSchema.safeParse({
        ...plan,
        proposalDigest: "private",
      }).success
    ).toBe(false);
  });
});
