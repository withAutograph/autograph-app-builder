// oxlint-disable-next-line jsdoc/check-tag-names -- Vitest file-environment pragma.
/** @vitest-environment jsdom */

import { act } from "react";
import { hydrateRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, expect, it } from "vitest";

import { AuthProvider } from "@better-auth-ui/react";
import { createAuthClient } from "better-auth/react";
import type { SignInPasskeyOptions } from "@better-auth-ui/core/plugins/passkey";
import { QueryClient } from "@tanstack/react-query";

import { PasskeyButton } from "./passkey-button";

const signInCalls: unknown[] = [];
const authClient = createAuthClient({
  plugins: [
    {
      getActions: () => ({
        signInPasskey: (options: SignInPasskeyOptions) => {
          signInCalls.push(options);
          throw new TypeError("Failed to fetch");
        },
      }),
      id: "passkey",
    },
  ],
});
const navigate = () => {};
const queryClient = new QueryClient();

const TestButton = ({ view }: { view: "signIn" | "signUp" }) => (
  <AuthProvider
    authClient={authClient}
    navigate={navigate}
    plugins={[{ id: "passkey", localization: { passkey: "Passkey" } }]}
    localization={{ auth: { continueWith: "Continue with {{provider}}" } }}
    queryClient={queryClient}
    redirectTo="/"
  >
    <PasskeyButton view={view} />
  </AuthProvider>
);

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
  signInCalls.length = 0;
  queryClient.clear();
});

it.each(["signIn", "signUp"] as const)(
  "keeps %s disabled until its client handler is hydrated",
  async (view) => {
    container = document.createElement("div");
    const markup = renderToString(<TestButton view={view} />);
    const template = document.createElement("template");
    template.content.append(document.createTextNode(markup));
    container.append(template.content);
    document.body.append(container);
    const button = container.querySelector("button");
    if (!button) {
      throw new Error("Expected passkey button to render");
    }
    expect(button.disabled).toBe(true);
    button.click();
    expect(signInCalls).toHaveLength(0);
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    await act(async () => {
      root = hydrateRoot(container, <TestButton view={view} />);
    });
    expect(container.querySelector("button")).toBe(button);
    expect(button.disabled).toBe(false);
  },
);

it("shows an inline retry after a hydrated verification transport failure", async () => {
  container = document.createElement("div");
  const markup = renderToString(<TestButton view="signIn" />);
  const template = document.createElement("template");
  template.content.append(document.createTextNode(markup));
  container.append(template.content);
  document.body.append(container);
  // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
  await act(async () => {
    root = hydrateRoot(container, <TestButton view="signIn" />);
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
  expect(signInCalls).toHaveLength(1);
  expect(container.querySelector("button")?.textContent).toContain(
    "Couldn’t use your passkey. Try again.",
  );
  expect(container.querySelector("button")?.disabled).toBe(false);
});
