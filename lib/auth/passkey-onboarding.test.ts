import { getTestInstance } from "better-auth/test";
import { describe, expect, it, vi } from "vitest";

import { PASSKEY_ONBOARDING_ALREADY_AUTHENTICATED } from "./passkey-contract";
import {
  authenticatedPasskeyRegistration,
  createPasskeyOnboardingPlugin,
  createPasskeyOnboardingToken,
  createPasskeyPlugin,
  issuePasskeyOnboardingContext,
  readPasskeyOnboardingConfig,
  verifyPasskeyOnboardingToken,
} from "./passkey-onboarding";

const secret = "p".repeat(32);
const previewEnvironment = {
  BETTER_AUTH_SECRET: secret,
  BETTER_AUTH_URL: "https://preview.example.test/api/auth",
  NODE_ENV: "production",
  PASSKEY_ONBOARDING: "local-preview-v1",
  PASSKEY_PREVIEW_PROTECTION: "vercel-authentication",
  VERCEL_DEPLOYMENT_ID: "deployment_123",
  VERCEL_ENV: "preview",
  VERCEL_URL: "preview.example.test",
} as const;
const previewConfig = readPasskeyOnboardingConfig(previewEnvironment)!;
const integrationConfig = {
  ...previewConfig,
  deploymentId: "local",
  origin: "http://localhost:3000",
  rpId: "localhost",
  secureCookies: false,
};
const fixedNow = new Date("2026-08-30T12:00:00.000Z");

it("allows the emulated browser suite to raise only the onboarding-context limit", () => {
  const hostedPlugin = createPasskeyOnboardingPlugin({
    config: integrationConfig,
  });
  const emulatedPlugin = createPasskeyOnboardingPlugin({
    config: integrationConfig,
    onboardingContextRateLimitMax: 600,
  });

  expect(hostedPlugin.rateLimit?.[0]).toMatchObject({ max: 10, window: 60 });
  expect(emulatedPlugin.rateLimit?.[0]).toMatchObject({ max: 600, window: 60 });
});

async function setupOnboarding(now: () => Date = () => fixedNow) {
  return getTestInstance(
    {
      basePath: "/api/auth",
      baseURL: integrationConfig.origin,
      logger: { disabled: true },
      plugins: [
        createPasskeyOnboardingPlugin({ config: integrationConfig, now }),
        createPasskeyPlugin({ config: integrationConfig, now }),
      ],
    },
    { port: 3000 }
  );
}

type OnboardingDatabase = Awaited<ReturnType<typeof setupOnboarding>>["db"];

async function insertOnboardingContext(
  database: OnboardingDatabase,
  input: {
    id: string;
    deploymentId: string;
    expiresAt: Date;
  }
) {
  await database.create({
    data: {
      createdAt: new Date("2026-08-30T10:00:00.000Z"),
      deploymentId: input.deploymentId,
      expiresAt: input.expiresAt,
      id: input.id,
      origin: "https://other-preview.example.test",
      rpId: "other-preview.example.test",
      tokenDigest: `digest-${input.id}`,
      userHandle: `user-${input.id}`,
    },
    forceAllowId: true,
    model: "passkeyOnboarding",
  });
}

async function requestOnboardingContext(
  fetchImplementation: Awaited<
    ReturnType<typeof setupOnboarding>
  >["customFetchImpl"],
  headers?: Headers
) {
  const requestHeaders = new Headers(headers);
  requestHeaders.set("origin", integrationConfig.origin);
  requestHeaders.set("content-type", "application/json");
  return fetchImplementation(
    `${integrationConfig.origin}/api/auth/passkey/onboarding-context`,
    {
      body: "{}",
      headers: requestHeaders,
      method: "POST",
    }
  );
}

async function requestRegistrationVerification(
  fetchImplementation: Awaited<
    ReturnType<typeof setupOnboarding>
  >["customFetchImpl"],
  headers: Headers,
  createSession?: true
) {
  const requestHeaders = new Headers(headers);
  requestHeaders.set("origin", integrationConfig.origin);
  requestHeaders.set("content-type", "application/json");
  return fetchImplementation(
    `${integrationConfig.origin}/api/auth/passkey/verify-registration`,
    {
      body: JSON.stringify({
        response: {},
        ...(createSession ? { createSession } : {}),
      }),
      headers: requestHeaders,
      method: "POST",
    }
  );
}

describe("passkey-first onboarding authority", () => {
  it("enables exact loopback development and protected Preview bindings", () => {
    expect(
      readPasskeyOnboardingConfig({
        BETTER_AUTH_SECRET: secret,
        BETTER_AUTH_URL: "http://localhost:3000/api/auth",
        NODE_ENV: "development",
        PASSKEY_ONBOARDING: "local-preview-v1",
      })
    ).toMatchObject({
      deploymentId: "local",
      origin: "http://localhost:3000",
      rpId: "localhost",
      secureCookies: false,
    });
    expect(readPasskeyOnboardingConfig(previewEnvironment)).toMatchObject({
      deploymentId: "deployment_123",
      origin: "https://preview.example.test",
      rpId: "preview.example.test",
      secureCookies: true,
    });
    expect(
      readPasskeyOnboardingConfig({
        APP_BUILDER_LOCAL_AUTH_EMULATION: "1",
        APP_BUILDER_LOCAL_PROVIDER_EMULATION: "1",
        BETTER_AUTH_SECRET: secret,
        BETTER_AUTH_URL: "https://localhost:3001/api/auth",
        NODE_ENV: "development",
        PASSKEY_ONBOARDING: "local-preview-v1",
      })
    ).toMatchObject({
      deploymentId: "local",
      origin: "https://localhost:3001",
      rpId: "localhost",
      secureCookies: true,
    });
    expect(
      readPasskeyOnboardingConfig({
        ...previewEnvironment,
        BETTER_AUTH_URL: undefined,
      })
    ).toMatchObject({ origin: "https://preview.example.test" });
  });

  it("binds provider-emulated Preview passkeys to its validated stable branch origin", () => {
    const branchEnvironment = {
      ...previewEnvironment,
      APP_BUILDER_PREVIEW_PROVIDER_EMULATION: "1",
      BETTER_AUTH_URL: "https://app-git-feature-team.vercel.app/api/auth",
      VERCEL_BRANCH_URL: "app-git-feature-team.vercel.app",
      VERCEL_URL: "app-deployment-team.vercel.app",
    } as const;

    expect(
      readPasskeyOnboardingConfig(branchEnvironment, {
        previewCanonicalOrigin: "https://app-git-feature-team.vercel.app",
      })
    ).toMatchObject({
      deploymentId: "deployment_123",
      origin: "https://app-git-feature-team.vercel.app",
      rpId: "app-git-feature-team.vercel.app",
      secureCookies: true,
    });
    expect(() => readPasskeyOnboardingConfig(branchEnvironment)).toThrow(
      "exact Vercel deployment metadata"
    );
    expect(() =>
      readPasskeyOnboardingConfig(branchEnvironment, {
        previewCanonicalOrigin: "https://other-git-feature-team.vercel.app",
      })
    ).toThrow("exact validated branch origin");
    expect(() =>
      readPasskeyOnboardingConfig(
        {
          ...branchEnvironment,
          APP_BUILDER_PREVIEW_PROVIDER_EMULATION: undefined,
        },
        {
          previewCanonicalOrigin: "https://app-git-feature-team.vercel.app",
        }
      )
    ).toThrow("exact validated branch origin");
  });

  it("rejects HTTPS loopback without both local emulation gates", () => {
    const localHttps = {
      APP_BUILDER_LOCAL_AUTH_EMULATION: "1",
      APP_BUILDER_LOCAL_PROVIDER_EMULATION: "1",
      BETTER_AUTH_SECRET: secret,
      BETTER_AUTH_URL: "https://localhost:3001/api/auth",
      NODE_ENV: "development",
      PASSKEY_ONBOARDING: "local-preview-v1",
    } as const;
    expect(() =>
      readPasskeyOnboardingConfig({
        ...localHttps,
        APP_BUILDER_LOCAL_PROVIDER_EMULATION: undefined,
      })
    ).toThrow("explicit local provider and authentication emulation gates");
    expect(() =>
      readPasskeyOnboardingConfig({
        ...localHttps,
        APP_BUILDER_LOCAL_AUTH_EMULATION: undefined,
      })
    ).toThrow("explicit local provider and authentication emulation gates");
    expect(() =>
      readPasskeyOnboardingConfig({
        ...localHttps,
        BETTER_AUTH_URL: "https://localhost:3002/api/auth",
      })
    ).toThrow("explicit local provider and authentication emulation gates");
    expect(() =>
      readPasskeyOnboardingConfig({
        ...localHttps,
        VERCEL_ENV: "development",
      })
    ).toThrow("non-Production loopback origin");
  });

  it("stays disabled without the exact feature flag", () => {
    expect(readPasskeyOnboardingConfig({})).toBeNull();
    expect(
      readPasskeyOnboardingConfig({
        ...previewEnvironment,
        PASSKEY_ONBOARDING: "1",
      })
    ).toBeNull();
  });

  it("rejects Production, missing protection, and mismatched Preview hosts", () => {
    expect(() =>
      readPasskeyOnboardingConfig({
        ...previewEnvironment,
        VERCEL_ENV: "production",
      })
    ).toThrow("unavailable in Production");
    expect(() =>
      readPasskeyOnboardingConfig({
        ...previewEnvironment,
        PASSKEY_PREVIEW_PROTECTION: undefined,
      })
    ).toThrow("protection acknowledgement");
    expect(() =>
      readPasskeyOnboardingConfig({
        ...previewEnvironment,
        VERCEL_URL: "other.example.test",
      })
    ).toThrow("exact Vercel deployment metadata");
  });

  it("binds signed contexts to deployment, origin, RP ID, and expiry", () => {
    const config = readPasskeyOnboardingConfig(previewEnvironment)!;
    const issued = createPasskeyOnboardingToken(
      config,
      new Date("2026-08-30T12:00:00Z")
    );
    expect(
      verifyPasskeyOnboardingToken(
        issued.token,
        config,
        new Date("2026-08-30T12:04:59Z")
      )
    ).toMatchObject({ digest: issued.digest, payload: issued.payload });
    expect(
      verifyPasskeyOnboardingToken(
        `${issued.token.slice(0, -1)}x`,
        config,
        new Date("2026-08-30T12:01:00Z")
      )
    ).toBeNull();
    expect(
      verifyPasskeyOnboardingToken(
        issued.token,
        { ...config, deploymentId: "other" },
        new Date("2026-08-30T12:01:00Z")
      )
    ).toBeNull();
    expect(
      verifyPasskeyOnboardingToken(
        issued.token,
        config,
        new Date("2026-08-30T12:05:01Z")
      )
    ).toBeNull();
  });

  it("deletes expired contexts globally through the expiry boundary and preserves future contexts", async () => {
    const now = vi.fn(() => fixedNow);
    const { customFetchImpl, db } = await setupOnboarding(now);
    await insertOnboardingContext(db, {
      deploymentId: "retired_deployment",
      expiresAt: new Date("2026-08-30T11:59:59.000Z"),
      id: "expired-other-deployment",
    });
    await insertOnboardingContext(db, {
      deploymentId: "retired_deployment",
      expiresAt: fixedNow,
      id: "boundary-other-deployment",
    });
    await insertOnboardingContext(db, {
      deploymentId: "other_deployment",
      expiresAt: new Date("2026-08-30T12:00:01.000Z"),
      id: "future-other-deployment",
    });

    const response = await requestOnboardingContext(customFetchImpl);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      context: expect.any(String),
    });
    expect(now).toHaveBeenCalledTimes(1);
    const rows = await db.findMany<{
      id: string;
      deploymentId: string;
      createdAt: Date;
      expiresAt: Date;
    }>({ model: "passkeyOnboarding" });
    expect(rows.map(({ id }) => id)).toContain("future-other-deployment");
    expect(rows.map(({ id }) => id)).not.toContain("expired-other-deployment");
    expect(rows.map(({ id }) => id)).not.toContain("boundary-other-deployment");
    const issued = rows.find(
      ({ deploymentId }) => deploymentId === integrationConfig.deploymentId
    );
    expect(rows).toHaveLength(2);
    expect(issued).toMatchObject({
      createdAt: fixedNow,
      expiresAt: new Date("2026-08-30T12:05:00.000Z"),
    });
  });

  it("fails closed when expired-context cleanup fails", async () => {
    const cleanupFailure = new Error("cleanup failed");
    const deleteMany = vi.fn().mockRejectedValue(cleanupFailure);
    const create = vi.fn();
    const adapter = { create, deleteMany } as unknown as Parameters<
      typeof issuePasskeyOnboardingContext
    >[0];

    await expect(
      issuePasskeyOnboardingContext(adapter, previewConfig, fixedNow)
    ).rejects.toBe(cleanupFailure);
    expect(deleteMany).toHaveBeenCalledWith({
      model: "passkeyOnboarding",
      where: [
        {
          field: "expiresAt",
          operator: "lte",
          value: fixedNow,
        },
      ],
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects context issuance for an authenticated session before cleanup", async () => {
    const now = vi.fn(() => fixedNow);
    const { customFetchImpl, db, signInWithTestUser } =
      await setupOnboarding(now);
    await insertOnboardingContext(db, {
      deploymentId: "retired_deployment",
      expiresAt: new Date("2026-08-30T11:59:59.000Z"),
      id: "expired-before-session-conflict",
    });
    const { headers } = await signInWithTestUser();

    const response = await requestOnboardingContext(customFetchImpl, headers);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: PASSKEY_ONBOARDING_ALREADY_AUTHENTICATED,
    });
    expect(now).not.toHaveBeenCalled();
    await expect(db.count({ model: "passkeyOnboarding" })).resolves.toBe(1);
    await expect(
      db.findOne({
        model: "passkeyOnboarding",
        where: [{ field: "id", value: "expired-before-session-conflict" }],
      })
    ).resolves.not.toBeNull();
  });

  it("rejects nonempty onboarding authority for a session while preserving context-free enrollment", () => {
    expect(authenticatedPasskeyRegistration("user_1", null)).toEqual({
      name: "Additional passkey",
      userId: "user_1",
    });
    expect(authenticatedPasskeyRegistration("user_1", "")).toEqual({
      name: "Additional passkey",
      userId: "user_1",
    });
    expect(
      authenticatedPasskeyRegistration(undefined, "onboarding-context")
    ).toBeNull();

    expect(() =>
      authenticatedPasskeyRegistration("user_1", "onboarding-context")
    ).toThrowError(
      expect.objectContaining({
        body: expect.objectContaining({
          code: PASSKEY_ONBOARDING_ALREADY_AUTHENTICATED,
        }),
        status: "CONFLICT",
        statusCode: 409,
      })
    );
  });

  it("rejects an onboarding verification race before Better Auth's user mismatch", async () => {
    const { customFetchImpl, signInWithTestUser } = await setupOnboarding();
    const { headers } = await signInWithTestUser();

    const response = await requestRegistrationVerification(
      customFetchImpl,
      headers,
      true
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: PASSKEY_ONBOARDING_ALREADY_AUTHENTICATED,
    });
  });

  it("leaves context-free Settings verification to Better Auth", async () => {
    const { customFetchImpl, signInWithTestUser } = await setupOnboarding();
    const { headers } = await signInWithTestUser();

    const response = await requestRegistrationVerification(
      customFetchImpl,
      headers
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "CHALLENGE_NOT_FOUND",
    });
  });
});
