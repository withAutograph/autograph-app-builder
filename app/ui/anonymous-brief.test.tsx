// oxlint-disable-next-line jsdoc/check-tag-names -- Vitest file-environment pragma.
/** @vitest-environment jsdom */

import { act } from "react";
import { hydrateRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";

import { AnonymousBrief } from "./anonymous-brief";
import { AnonymousBuilder } from "./anonymous-builder";

const navigation = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => navigation }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
let root: Root | undefined;
let container: HTMLDivElement;
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  container?.remove();
  sessionStorage.clear();
  vi.clearAllMocks();
});

it("renders the full server composition and disables every interactive control before hydration", () => {
  container = document.createElement("div");
  container.innerHTML = renderToString(<AnonymousBuilder />);
  expect(container.querySelector("h1")?.textContent).toBe("Build an app");
  expect(container.querySelector("label")?.htmlFor).toBe("anonymous-brief");
  expect(container.querySelector("textarea")?.disabled).toBe(true);
  expect([...container.querySelectorAll("button")].every((button) => button.disabled)).toBe(true);
});

it("hydrates the brief island and persists the selected brief before sign-in navigation", async () => {
  container = document.createElement("div");
  container.innerHTML = renderToString(<AnonymousBrief />);
  document.body.append(container);
  const textarea = container.querySelector("textarea");
  await act(async () => {
    root = hydrateRoot(container, <AnonymousBrief />);
  });
  expect(container.querySelector("textarea")).toBe(textarea);
  expect(textarea?.disabled).toBe(false);
  await act(async () => container.querySelectorAll("button")[1]!.click());
  expect(textarea?.value).toBe("Build a customer feedback portal");
  await act(async () => container.querySelector("button")!.click());
  expect(sessionStorage.getItem("autograph-app-brief")).toBe("Build a customer feedback portal");
  expect(navigation.push).toHaveBeenCalledWith("/auth/sign-in?callbackURL=%2F");
});

it("supports the isolated story continuation without browser navigation", async () => {
  const onContinue = vi.fn();
  container = document.createElement("div");
  container.innerHTML = renderToString(<AnonymousBrief onContinue={onContinue} />);
  document.body.append(container);
  await act(async () => {
    root = hydrateRoot(container, <AnonymousBrief onContinue={onContinue} />);
  });
  await act(async () => container.querySelectorAll("button")[1]!.click());
  await act(async () => container.querySelector("button")!.click());
  expect(onContinue).toHaveBeenCalledWith("Build a customer feedback portal");
  expect(navigation.push).not.toHaveBeenCalled();
  expect(sessionStorage.getItem("autograph-app-brief")).toBeNull();
});
