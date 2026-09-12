import { Suspense, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RouteProviders } from "./route-providers";

const { passkeysFlag } = vi.hoisted(() => ({ passkeysFlag: vi.fn() }));

vi.mock("@/lib/feature-flags", () => ({ passkeysFlag }));
vi.mock("@/components/providers", () => ({
  AuthRouteProvider: ({
    children,
    passkeysEnabled,
  }: {
    children: ReactNode;
    passkeysEnabled: boolean;
  }) => <section data-passkeys={String(passkeysEnabled)}>{children}</section>,
}));

describe("route-local auth configuration", () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    { mode: "development", preview: false, emulated: false, credentials: false, enabled: true },
    { mode: "production", preview: true, emulated: true, credentials: false, enabled: true },
    { mode: "production", preview: true, emulated: false, credentials: false, enabled: false },
    { mode: "production", preview: false, emulated: true, credentials: false, enabled: false },
    { mode: "production", preview: false, emulated: false, credentials: true, enabled: true },
  ] as const)(
    "resolves social provider visibility from the actual environment: %j",
    async (scenario) => {
      vi.stubEnv("NODE_ENV", scenario.mode);
      vi.stubEnv("VERCEL_ENV", scenario.preview ? "preview" : "production");
      vi.stubEnv("APP_BUILDER_PREVIEW_PROVIDER_EMULATION", scenario.emulated ? "1" : undefined);
      for (const key of [
        "GITHUB_CLIENT_ID",
        "GITHUB_CLIENT_SECRET",
        "VERCEL_AUTH_CLIENT_ID",
        "VERCEL_AUTH_CLIENT_SECRET",
      ]) {
        vi.stubEnv(key, scenario.credentials ? "test-configured" : undefined);
      }
      passkeysFlag.mockResolvedValue(false);
      const { children: configuration } = RouteProviders({ fallback: null, children: null }).props;
      const resolved = await configuration.type(configuration.props);
      expect(resolved.props.githubAuthEnabled).toBe(scenario.enabled);
      expect(resolved.props.vercelAuthEnabled).toBe(scenario.enabled);
    },
  );

  it.each([true, false])(
    "keeps the actual passkey flag (%s) below the route shell",
    async (enabled) => {
      passkeysFlag.mockResolvedValue(enabled);
      const fallback = <h1>Create your Autograph account</h1>;
      const children = <p>Authenticated route content</p>;
      const boundary = RouteProviders({ fallback, children });

      expect(boundary.type).toBe(Suspense);
      expect(boundary.props.fallback).toBe(fallback);
      const configuration = boundary.props.children;
      const resolved = await configuration.type(configuration.props);
      expect(resolved.props.passkeysEnabled).toBe(enabled);
      expect(resolved.props.children).toBe(children);
    },
  );
});
