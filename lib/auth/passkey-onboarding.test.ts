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
  NODE_ENV: "production",
  VERCEL_ENV: "preview",
  VERCEL_URL: "preview.example.test",
  VERCEL_DEPLOYMENT_ID: "deployment_123",
  BETTER_AUTH_URL: "https://preview.example.test/api/auth",
  BETTER_AUTH_SECRET: secret,
  PASSKEY_ONBOARDING: "local-preview-v1",
  PASSKEY_PREVIEW_PROTECTION: "vercel-authentication",
} as const;
const previewConfig = readPasskeyOnboardingConfig(previewEnvironment)!;
const integrationConfig = {
  ...previewConfig,
  origin: "http://localhost:3000",
  rpId: "localhost",
  deploymentId: "local",
  secureCookies: false,
};
const fixedNow = new Date("2026-08-30T12:00:00.000Z");

async function setupOnboarding(now: () => Date = () => fixedNow) {
  return getTestInstance(
    {
      baseURL: integrationConfig.origin,
      basePath: "/api/auth",
      logger: { disabled: true },
      plugins: [
        createPasskeyOnboardingPlugin({ config: integrationConfig, now }),
        createPasskeyPlugin({ config: integrationConfig, now }),
      ],
    },
    { port: 3000 },
  );
}

type OnboardingDatabase = Awaited<ReturnType<typeof setupOnboarding>>["db"];

async function insertOnboardingContext(
  database: OnboardingDatabase,
  input: {
    id: string;
    deploymentId: string;
    expiresAt: Date;
  },
) {
  await database.create({
    model: "passkeyOnboarding",
    data: {
      id: input.id,
      tokenDigest: `digest-${input.id}`,
      deploymentId: input.deploymentId,
      origin: "https://other-preview.example.test",
      rpId: "other-preview.example.test",
      userHandle: `user-${input.id}`,
      createdAt: new Date("2026-08-30T10:00:00.000Z"),
      expiresAt: input.expiresAt,
    },
    forceAllowId: true,
  });
}

async function requestOnboardingContext(
  fetchImplementation: Awaited<
    ReturnType<typeof setupOnboarding>
  >["customFetchImpl"],
  headers?: Headers,
) {
  const requestHeaders = new Headers(headers);
  requestHeaders.set("origin", integrationConfig.origin);
  requestHeaders.set("content-type", "application/json");
  return fetchImplementation(
    `${integrationConfig.origin}/api/auth/passkey/onboarding-context`,
    {
      method: "POST",
      headers: requestHeaders,
      body: "{}",
    },
  );
}

async function requestRegistrationVerification(
  fetchImplementation: Awaited<
    ReturnType<typeof setupOnboarding>
  >["customFetchImpl"],
  headers: Headers,
  createSession?: true,
) {
  const requestHeaders = new Headers(headers);
  requestHeaders.set("origin", integrationConfig.origin);
  requestHeaders.set("content-type", "application/json");
  return fetchImplementation(
    `${integrationConfig.origin}/api/auth/passkey/verify-registration`,
    {
      method: "POST",
      headers: requestHeaders,
      body: JSON.stringify({
        response: {},
        ...(createSession ? { createSession } : {}),
      }),
    },
  );
}

describe("passkey-first onboarding authority", () => {
  it("enables exact loopback development and protected Preview bindings", () => {
    expect(
      readPasskeyOnboardingConfig({
        NODE_ENV: "development",
        BETTER_AUTH_URL: "http://localhost:3000/api/auth",
        BETTER_AUTH_SECRET: secret,
        PASSKEY_ONBOARDING: "local-preview-v1",
      }),
    ).toMatchObject({
      origin: "http://localhost:3000",
      rpId: "localhost",
      deploymentId: "local",
      secureCookies: false,
    });
    expect(readPasskeyOnboardingConfig(previewEnvironment)).toMatchObject({
      origin: "https://preview.example.test",
      rpId: "preview.example.test",
      deploymentId: "deployment_123",
      secureCookies: true,
    });
    expect(
      readPasskeyOnboardingConfig({
        NODE_ENV: "development",
        APP_BUILDER_LOCAL_PROVIDER_EMULATION: "1",
        APP_BUILDER_LOCAL_AUTH_EMULATION: "1",
        BETTER_AUTH_URL: "https://localhost:3001/api/auth",
        BETTER_AUTH_SECRET: secret,
        PASSKEY_ONBOARDING: "local-preview-v1",
      }),
    ).toMatchObject({
      origin: "https://localhost:3001",
      rpId: "localhost",
      deploymentId: "local",
      secureCookies: true,
    });
    expect(
      readPasskeyOnboardingConfig({
        ...previewEnvironment,
        BETTER_AUTH_URL: undefined,
      }),
    ).toMatchObject({ origin: "https://preview.example.test" });
  });

  it("rejects HTTPS loopback without both local emulation gates", () => {
    const localHttps = {
      NODE_ENV: "development",
      APP_BUILDER_LOCAL_PROVIDER_EMULATION: "1",
      APP_BUILDER_LOCAL_AUTH_EMULATION: "1",
      BETTER_AUTH_URL: "https://localhost:3001/api/auth",
      BETTER_AUTH_SECRET: secret,
      PASSKEY_ONBOARDING: "local-preview-v1",
    } as const;
    expect(() =>
      readPasskeyOnboardingConfig({
        ...localHttps,
        APP_BUILDER_LOCAL_PROVIDER_EMULATION: undefined,
      }),
    ).toThrow("explicit local provider and authentication emulation gates");
    expect(() =>
      readPasskeyOnboardingConfig({
        ...localHttps,
        APP_BUILDER_LOCAL_AUTH_EMULATION: undefined,
      }),
    ).toThrow("explicit local provider and authentication emulation gates");
    expect(() =>
      readPasskeyOnboardingConfig({
        ...localHttps,
        BETTER_AUTH_URL: "https://localhost:3002/api/auth",
      }),
    ).toThrow("explicit local provider and authentication emulation gates");
    expect(() =>
      readPasskeyOnboardingConfig({
        ...localHttps,
        VERCEL_ENV: "development",
      }),
    ).toThrow("non-Production loopback origin");
  });

  it("stays disabled without the exact feature flag", () => {
    expect(readPasskeyOnboardingConfig({})).toBeNull();
    expect(
      readPasskeyOnboardingConfig({
        ...previewEnvironment,
        PASSKEY_ONBOARDING: "1",
      }),
    ).toBeNull();
  });

  it("rejects Production, missing protection, and mismatched Preview hosts", () => {
    expect(() =>
      readPasskeyOnboardingConfig({
        ...previewEnvironment,
        VERCEL_ENV: "production",
      }),
    ).toThrow("unavailable in Production");
    expect(() =>
      readPasskeyOnboardingConfig({
        ...previewEnvironment,
        PASSKEY_PREVIEW_PROTECTION: undefined,
      }),
    ).toThrow("protection acknowledgement");
    expect(() =>
      readPasskeyOnboardingConfig({
        ...previewEnvironment,
        VERCEL_URL: "other.example.test",
      }),
    ).toThrow("exact Vercel deployment metadata");
  });

  it("binds signed contexts to deployment, origin, RP ID, and expiry", () => {
    const config = readPasskeyOnboardingConfig(previewEnvironment)!;
    const issued = createPasskeyOnboardingToken(
      config,
      new Date("2026-08-30T12:00:00Z"),
    );
    expect(
      verifyPasskeyOnboardingToken(
        issued.token,
        config,
        new Date("2026-08-30T12:04:59Z"),
      ),
    ).toMatchObject({ digest: issued.digest, payload: issued.payload });
    expect(
      verifyPasskeyOnboardingToken(
        `${issued.token.slice(0, -1)}x`,
        config,
        new Date("2026-08-30T12:01:00Z"),
      ),
    ).toBeNull();
    expect(
      verifyPasskeyOnboardingToken(
        issued.token,
        { ...config, deploymentId: "other" },
        new Date("2026-08-30T12:01:00Z"),
      ),
    ).toBeNull();
    expect(
      verifyPasskeyOnboardingToken(
        issued.token,
        config,
        new Date("2026-08-30T12:05:01Z"),
      ),
    ).toBeNull();
  });

  it("deletes expired contexts globally through the expiry boundary and preserves future contexts", async () => {
    const now = vi.fn(() => fixedNow);
    const { customFetchImpl, db } = await setupOnboarding(now);
    await insertOnboardingContext(db, {
      id: "expired-other-deployment",
      deploymentId: "retired_deployment",
      expiresAt: new Date("2026-08-30T11:59:59.000Z"),
    });
    await insertOnboardingContext(db, {
      id: "boundary-other-deployment",
      deploymentId: "retired_deployment",
      expiresAt: fixedNow,
    });
    await insertOnboardingContext(db, {
      id: "future-other-deployment",
      deploymentId: "other_deployment",
      expiresAt: new Date("2026-08-30T12:00:01.000Z"),
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
      ({ deploymentId }) => deploymentId === integrationConfig.deploymentId,
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
    const adapter = { deleteMany, create } as unknown as Parameters<
      typeof issuePasskeyOnboardingContext
    >[0];

    await expect(
      issuePasskeyOnboardingContext(adapter, previewConfig, fixedNow),
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
      id: "expired-before-session-conflict",
      deploymentId: "retired_deployment",
      expiresAt: new Date("2026-08-30T11:59:59.000Z"),
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
      }),
    ).resolves.not.toBeNull();
  });

  it("rejects nonempty onboarding authority for a session while preserving context-free enrollment", () => {
    expect(authenticatedPasskeyRegistration("user_1", null)).toEqual({
      userId: "user_1",
      name: "Additional passkey",
    });
    expect(authenticatedPasskeyRegistration("user_1", "")).toEqual({
      userId: "user_1",
      name: "Additional passkey",
    });
    expect(
      authenticatedPasskeyRegistration(undefined, "onboarding-context"),
    ).toBeNull();

    expect(() =>
      authenticatedPasskeyRegistration("user_1", "onboarding-context"),
    ).toThrowError(
      expect.objectContaining({
        status: "CONFLICT",
        statusCode: 409,
        body: expect.objectContaining({
          code: PASSKEY_ONBOARDING_ALREADY_AUTHENTICATED,
        }),
      }),
    );
  });

  it("rejects an onboarding verification race before Better Auth's user mismatch", async () => {
    const { customFetchImpl, signInWithTestUser } = await setupOnboarding();
    const { headers } = await signInWithTestUser();

    const response = await requestRegistrationVerification(
      customFetchImpl,
      headers,
      true,
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
      headers,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "CHALLENGE_NOT_FOUND",
    });
  });
});
