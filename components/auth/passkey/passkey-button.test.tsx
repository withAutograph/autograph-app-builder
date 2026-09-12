// oxlint-disable-next-line jsdoc/check-tag-names -- Vitest file-environment pragma.
/** @vitest-environment jsdom */

import { act } from "react";
import { hydrateRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";

import { PasskeyButton } from "./passkey-button";

const auth = vi.hoisted(() => ({ signIn: vi.fn(), navigate: vi.fn() }));
vi.mock("@better-auth-ui/react", () => ({
  useAuth: () => ({
    authClient: {},
    localization: { auth: { continueWith: "Continue with {{provider}}" } },
    redirectTo: "/",
    navigate: auth.navigate,
  }),
  useAuthPlugin: () => ({ localization: { passkey: "Passkey" } }),
}));
vi.mock("@better-auth-ui/react/plugins/passkey", () => ({
  useSignInPasskey: () => ({ mutateAsync: auth.signIn }),
  useAddPasskey: () => ({ mutateAsync: vi.fn() }),
  usePasskeyAutoFill: vi.fn(),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
let root: Root | undefined;
let container: HTMLDivElement;
afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
  }
  root = undefined;
  container?.remove();
  vi.clearAllMocks();
});

it.each(["signIn", "signUp"] as const)(
  "keeps %s disabled until its client handler is hydrated",
  async (view) => {
    container = document.createElement("div");
    container.innerHTML = renderToString(<PasskeyButton view={view} />);
    document.body.append(container);
    const button = container.querySelector("button")!;
    expect(button.disabled).toBe(true);
    button.click();
    expect(auth.signIn).not.toHaveBeenCalled();
    await act(async () => {
      root = hydrateRoot(container, <PasskeyButton view={view} />);
    });
    expect(container.querySelector("button")).toBe(button);
    expect(button.disabled).toBe(false);
  },
);

it("shows an inline retry after a hydrated verification transport failure", async () => {
  auth.signIn.mockRejectedValueOnce(new TypeError("Failed to fetch"));
  container = document.createElement("div");
  container.innerHTML = renderToString(<PasskeyButton view="signIn" />);
  document.body.append(container);
  await act(async () => {
    root = hydrateRoot(container, <PasskeyButton view="signIn" />);
  });
  await act(async () => container.querySelector("button")!.click());
  expect(auth.signIn).toHaveBeenCalledOnce();
  expect(container.querySelector("button")?.textContent).toContain("Passkey failed (try again)");
  expect(container.querySelector("button")?.disabled).toBe(false);
  expect(auth.navigate).not.toHaveBeenCalled();
});
