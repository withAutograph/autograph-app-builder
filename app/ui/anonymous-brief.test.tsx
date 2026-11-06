// oxlint-disable-next-line jsdoc/check-tag-names -- Vitest file-environment pragma.
/** @vitest-environment jsdom */

import { act } from "react";
import type { ReactNode } from "react";
import { hydrateRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, expect, it } from "vitest";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";

import { AnonymousBrief } from "./anonymous-brief";
import { AnonymousBuilder } from "./anonymous-builder";

const navigationCalls: { args: unknown[]; method: string }[] = [];
const recordNavigation = (method: string, ...args: unknown[]) => {
  navigationCalls.push({ args, method });
};
const navigation = {
  back: () => {
    recordNavigation("back");
  },
  bfcacheId: "anonymous-brief-test",
  forward: () => {
    recordNavigation("forward");
  },
  prefetch: (href: string) => {
    recordNavigation("prefetch", href);
  },
  push: (href: string) => {
    recordNavigation("push", href);
  },
  refresh: () => {
    recordNavigation("refresh");
  },
  replace: (href: string) => {
    recordNavigation("replace", href);
  },
};

const withRouter = (element: ReactNode) => (
  <AppRouterContext.Provider value={navigation}>{element}</AppRouterContext.Provider>
);

const renderMarkup = (element: ReactNode) => {
  const markup = renderToString(withRouter(element));
  return document.createRange().createContextualFragment(markup);
};

const requireElement = (element: Element | null | undefined): HTMLElement => {
  if (!(element instanceof HTMLElement)) {
    throw new Error("Expected interactive element to exist");
  }
  return element;
};

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
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
  sessionStorage.clear();
  navigationCalls.length = 0;
});

it("renders the full server composition and disables every interactive control before hydration", () => {
  container = document.createElement("div");
  container.replaceChildren(renderMarkup(<AnonymousBuilder />));
  expect(container.querySelector("h1")?.textContent).toBe("Build an app");
  expect(container.querySelector("label")?.htmlFor).toBe("anonymous-brief");
  expect(container.querySelector("textarea")?.disabled).toBe(true);
  expect([...container.querySelectorAll("button")].every((button) => button.disabled)).toBe(true);
});

it("hydrates the brief island and persists the selected brief before sign-in navigation", async () => {
  container = document.createElement("div");
  container.replaceChildren(renderMarkup(<AnonymousBrief />));
  document.body.append(container);
  const textarea = container.querySelector("textarea");
  // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning React act callback
  await act(async () => {
    root = hydrateRoot(container, withRouter(<AnonymousBrief />));
  });
  expect(container.querySelector("textarea")).toBe(textarea);
  expect(textarea?.disabled).toBe(false);
  // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning React act callback
  await act(async () => {
    requireElement(container.querySelectorAll("button")[1]).click();
  });
  expect(textarea?.value).toBe("Build a customer feedback portal");
  // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning React act callback
  await act(async () => {
    requireElement(container.querySelector("button")).click();
  });
  expect(sessionStorage.getItem("autograph-app-brief")).toBe("Build a customer feedback portal");
  expect(navigationCalls).toContainEqual({
    args: ["/auth/sign-in?callbackURL=%2F"],
    method: "push",
  });
});

it("supports the isolated story continuation without browser navigation", async () => {
  const continuedBriefs: string[] = [];
  const continueBrief = (brief: string) => {
    continuedBriefs.push(brief);
  };
  container = document.createElement("div");
  container.replaceChildren(renderMarkup(<AnonymousBrief onContinue={continueBrief} />));
  document.body.append(container);
  // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning React act callback
  await act(async () => {
    root = hydrateRoot(container, withRouter(<AnonymousBrief onContinue={continueBrief} />));
  });
  // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning React act callback
  await act(async () => {
    requireElement(container.querySelectorAll("button")[1]).click();
  });
  // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning React act callback
  await act(async () => {
    requireElement(container.querySelector("button")).click();
  });
  expect(continuedBriefs).toEqual(["Build a customer feedback portal"]);
  expect(navigationCalls.some(({ method }) => method === "push")).toBe(false);
  expect(sessionStorage.getItem("autograph-app-brief")).toBeNull();
});
