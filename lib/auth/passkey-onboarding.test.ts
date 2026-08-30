import { describe, expect, it } from "vitest";

import {
  createPasskeyOnboardingToken,
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
        ...previewEnvironment,
        BETTER_AUTH_URL: undefined,
      }),
    ).toMatchObject({ origin: "https://preview.example.test" });
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
});
