import { Suspense, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

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
