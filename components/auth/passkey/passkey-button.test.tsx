// oxlint-disable-next-line jsdoc/check-tag-names -- Vitest file-environment pragma.
/** @vitest-environment jsdom */

import { act } from "react";
import { hydrateRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";

import { AuthProvider } from "@better-auth-ui/react";
import { passkeyPlugin } from "@/lib/auth/passkey-plugin";

import { PasskeyButton } from "./passkey-button";

const auth = { addPasskey: vi.fn(), navigate: vi.fn(), signIn: vi.fn() };
const authClient = {
  passkey: { addPasskey: auth.addPasskey },
  signIn: { passkey: auth.signIn },
};
const passkeyAuthProvider = (view: "signIn" | "signUp") => (
  <AuthProvider
    authClient={authClient}
    Link={({ children }) => <a>{children}</a>}
    navigate={(options) => {
      auth.navigate(options);
    }}
    plugins={[passkeyPlugin({ autoFill: false })]}
    redirectTo="/"
  >
    <PasskeyButton view={view} />
  </AuthProvider>
);

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
let root: Root | null = null;
let container: HTMLDivElement;
afterEach(async () => {
  if (root) {
    await act(async () => {
      root?.unmount();
      await Promise.resolve();
    });
  }
  root = null;
  container?.remove();
  vi.clearAllMocks();
});

it.each(["signIn", "signUp"] as const)(
  "keeps %s disabled until its client handler is hydrated",
  async (view) => {
    container = document.createElement("div");
    container.textContent = "";
    container.append(
      document.createRange().createContextualFragment(renderToString(passkeyAuthProvider(view))),
    );
    document.body.append(container);
    const button = container.querySelector("button");
    if (!button) {
      throw new Error("Expected passkey button to render");
    }
    expect(button.disabled).toBe(true);
    button.click();
    expect(auth.signIn).not.toHaveBeenCalled();
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    await act(async () => {
      root = hydrateRoot(container, passkeyAuthProvider(view));
    });
    expect(container.querySelector("button")).toBe(button);
    expect(button.disabled).toBe(false);
  },
);

it("shows an inline retry after a hydrated verification transport failure", async () => {
  auth.signIn.mockRejectedValueOnce(new TypeError("Failed to fetch"));
  container = document.createElement("div");
  container.textContent = "";
  container.append(
    document.createRange().createContextualFragment(renderToString(passkeyAuthProvider("signIn"))),
  );
  document.body.append(container);
  // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
  await act(async () => {
    root = hydrateRoot(container, passkeyAuthProvider("signIn"));
  });
  const button = container.querySelector("button");
  if (!button) {
    throw new Error("Expected passkey button to render");
  }
  await act(
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    async () => {
      button.click();
    },
  );
  expect(auth.signIn).toHaveBeenCalledOnce();
  expect(container.querySelector("button")?.textContent).toContain(
    "Couldn’t use your passkey. Try again.",
  );
  expect(container.querySelector("button")?.disabled).toBe(false);
  expect(auth.navigate).not.toHaveBeenCalled();
});
