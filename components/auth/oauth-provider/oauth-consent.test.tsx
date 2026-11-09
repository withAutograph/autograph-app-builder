// @vitest-environment jsdom
import { authQueryKeys } from "@better-auth-ui/core";
import { oauthProviderQueryKeys } from "@better-auth-ui/core/plugins/oauth-provider";
import { AuthProvider } from "@better-auth-ui/react";
import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import { QueryClient } from "@tanstack/react-query";
import { createAuthClient } from "better-auth/react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { oauthProviderPlugin } from "@/lib/auth/oauth-provider-plugin";
import { OAuthConsent } from "./oauth-consent";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
let root: Root | null = null;
let container: HTMLDivElement | null = null;
let queryClient: QueryClient | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  queryClient?.clear();
  root = null;
  container = null;
  queryClient = null;
  window.history.replaceState(null, "", "/");
});

const renderConsent = (search: string, authenticated = true) => {
  window.history.replaceState(null, "", `/auth/oauth-consent${search}`);
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({}));
  const authClient = createAuthClient({
    baseURL: "http://localhost:3000/api/auth",
    fetchOptions: { customFetchImpl: fetch },
    plugins: [oauthProviderClient()],
  });
  const activeQueryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
  });
  activeQueryClient.setQueryData(
    authQueryKeys.session,
    authenticated
      ? {
          session: { id: "session-1" },
          user: { id: "user-1", name: "Ada", email: "ada@example.com" },
        }
      : null,
  );
  activeQueryClient.setQueryData(oauthProviderQueryKeys.publicClient("client-123"), {
    client_id: "client-123",
    client_name: "Example App",
    client_uri: "https://example.com",
    logo_uri: "data:text/html,unsafe",
    policy_uri: "https://example.com/privacy",
    tos_uri: "data:text/html,unsafe",
  });
  queryClient = activeQueryClient;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <AuthProvider
        authClient={authClient}
        queryClient={activeQueryClient}
        navigate={({ to }) => {
          void to;
        }}
        plugins={[oauthProviderPlugin()]}
        Link={({ href, children }) => <a href={href}>{children}</a>}
      >
        <OAuthConsent />
      </AuthProvider>,
    );
  });
  return { view: container, fetch };
};

it("rejects requests without a client ID and signed-out sessions", () => {
  const { view } = renderConsent("?scope=openid");
  expect(view.textContent).toMatch(/invalid/iu);
  expect(view.querySelector("button")).toBeNull();
  act(() => root?.unmount());
  container?.remove();
  const signedOut = renderConsent("?client_id=client-123&scope=openid", false);
  expect(signedOut.view.textContent).toMatch(/invalid/iu);
  expect(signedOut.view.querySelector("button")).toBeNull();
});

it.each([
  ["Allow", true],
  ["Cancel", false],
])("shows the request and submits %s consent", async (label, accept) => {
  const { view, fetch } = renderConsent("?client_id=client-123&scope=openid%20email");
  expect(view.textContent).toContain("Example App");
  expect(view.textContent).toContain("Ada");
  expect(view.textContent).toContain("View your email address");
  expect(view.querySelector('a[href="https://example.com/privacy"]')).not.toBeNull();
  expect(view.querySelector('a[href^="data:"]')).toBeNull();
  const button = [...view.querySelectorAll("button")].find((item) =>
    item.textContent?.includes(label),
  );
  if (button === undefined) {
    throw new Error(`Expected ${label} button`);
  }
  expect(button.disabled).toBe(false);
  await act(async () => {
    button.click();
    await vi.waitFor(() => {
      expect(fetch).toHaveBeenCalled();
    });
  });
  const call = fetch.mock.calls.find(([input]) =>
    new Request(input).url.includes("/oauth2/consent"),
  );
  const body = z.string().parse(call?.[1]?.body);
  expect(JSON.parse(body)).toMatchObject({ accept });
});
