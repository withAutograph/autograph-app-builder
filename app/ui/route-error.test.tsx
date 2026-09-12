// @vitest-environment jsdom

import { act } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import ProductError from "../(product)/error";
import AuthError from "../(product)/auth/error";
import SettingsError from "../(product)/settings/error";
import HandoffError from "../(product)/handoff/error";
import GitHubError from "../(product)/github/error";
import VercelError from "../(product)/vercel/error";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("native route error recovery", () => {
  it.each([
    [ProductError, "Unable to load Autograph"],
    [AuthError, "Unable to load authentication"],
    [SettingsError, "Unable to load settings"],
    [HandoffError, "Unable to load your handoff"],
    [GitHubError, "Unable to load GitHub connections"],
    [VercelError, "Unable to load Vercel connections"],
  ] as const)(
    "recovers %s with Next retry without exposing error details",
    async (Boundary, title) => {
      const retry = vi.fn();
      const error = Object.assign(new Error("sensitive provider token"), {
        digest: "internal-digest",
      });
      const element = <Boundary error={error} retry={retry} />;
      const container = document.createElement("div");
      container.innerHTML = renderToString(element);
      document.body.append(container);
      expect(container.textContent).toContain(title);
      expect(container.textContent).not.toContain(error.message);
      expect(container.textContent).not.toContain(error.digest);
      expect(container.querySelector('[role="alert"]')).not.toBeNull();
      const button = container.querySelector("button")!;
      expect(button.disabled).toBe(true);
      button.click();
      expect(retry).not.toHaveBeenCalled();

      const root = hydrateRoot(container, element);
      try {
        await act(async () => {});
        expect(container.querySelector("button")).toBe(button);
        expect(button.disabled).toBe(false);
        expect(retry).not.toHaveBeenCalled();
        // oxlint-disable-next-line eslint/require-await -- preserve React act callback contract
        await act(async () => button.click());
        expect(retry).toHaveBeenCalledOnce();
      } finally {
        // oxlint-disable-next-line eslint/require-await -- preserve React act callback contract
        await act(async () => root.unmount());
        container.remove();
      }
    },
  );
});
