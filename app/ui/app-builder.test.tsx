/** @vitest-environment jsdom */

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import axe from "axe-core";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

import { AppBuilder } from "./app-builder";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement | undefined;

async function render(ui: ReactNode) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(ui));
  return container;
}

async function fill(
  control: HTMLInputElement | HTMLTextAreaElement,
  value: string,
) {
  const prototype =
    control instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  await act(async () => {
    setter?.call(control, value);
    control.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function click(element: HTMLElement) {
  await act(async () => element.click());
}

afterEach(async () => {
  vi.useRealTimers();
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe("Vercel-faithful App Builder flow", () => {
  it("renders the anonymous composer with authentication handoff", async () => {
    const view = await render(
      <AppBuilder authenticated={false} user={{ name: "", email: "" }} />,
    );
    expect(view.querySelector("h1")?.textContent).toBe("Build an app");
    expect(view.textContent).toContain("What should this app do?");
    expect(view.querySelector('a[href^="/auth/sign-in"]')).not.toBeNull();
    expect(view.querySelector("button")?.hasAttribute("disabled")).toBe(true);
  });

  it("keeps the approved field substitutions and Vercel control order", async () => {
    const view = await render(
      <AppBuilder
        authenticated
        user={{ name: "Taylor", email: "taylor@example.com" }}
      />,
    );
    expect(view.querySelector("h1")?.textContent).toBe("Build an app");
    expect(view.textContent).toContain("Vercel Team");
    expect(view.textContent).toContain("App Name");
    expect(view.textContent).toContain("App Brief");
    expect(view.textContent).toContain("Channels");
    expect(view.textContent).toContain("Connections");
    expect(view.textContent).not.toContain("Agent Name");

    const orderedControls = [
      view.querySelector("#app-name"),
      view.querySelector("#app-brief"),
      view.querySelector('[aria-label="Select a Vercel Team"]'),
      view.querySelector('[aria-label="Git Scope"]'),
    ];
    for (let index = 0; index < orderedControls.length - 1; index += 1) {
      expect(
        orderedControls[index]!.compareDocumentPosition(
          orderedControls[index + 1]!,
        ) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }

    const accessibility = await axe.run(view, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(accessibility.violations).toEqual([]);
  });

  it("copies the canonical brief and advances through truthful handoff states", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const view = await render(
      <AppBuilder
        authenticated
        user={{ name: "Taylor", email: "taylor@example.com" }}
      />,
    );

    await fill(
      view.querySelector<HTMLInputElement>("#app-name")!,
      "support-app",
    );
    await fill(
      view.querySelector<HTMLInputElement>("#repository-name")!,
      "support-app",
    );
    await click(
      [...view.querySelectorAll("button")].find(
        (button) => button.textContent === "Create App",
      )!,
    );

    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining("App Name:\nsupport-app"),
    );
    expect(view.textContent).toContain("Handoff");
    expect(view.textContent).toContain("Preparing App Brief");

    for (let index = 0; index < 6; index += 1) {
      await act(async () => vi.advanceTimersByTimeAsync(700));
    }
    expect(view.textContent).toContain("App Brief Ready!");
    expect(view.textContent).not.toContain("deployed");
  });

  it("opens the account menu and changes the selected theme", async () => {
    const view = await render(
      <AppBuilder
        authenticated
        user={{ name: "Taylor", email: "taylor@example.com" }}
      />,
    );
    await click(
      view.querySelector<HTMLButtonElement>(
        '[aria-label="Open account menu"]',
      )!,
    );
    expect(view.querySelector('[role="dialog"]')?.textContent).toContain(
      "Taylor",
    );
    await click(
      view.querySelector<HTMLButtonElement>(
        '[role="radio"][aria-label="dark"]',
      )!,
    );
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("matches the repository privacy and connection-browser interactions", async () => {
    const view = await render(
      <AppBuilder
        authenticated
        user={{ name: "Taylor", email: "taylor@example.com" }}
      />,
    );

    const privacy = view.querySelector<HTMLInputElement>(
      '[aria-label="Private repository"] input',
    )!;
    expect(privacy.checked).toBe(true);
    expect(view.textContent).toContain("Private Repository Name");
    expect(view.querySelector('[role="tooltip"]')?.textContent?.trim()).toBe(
      "This repository will be private.",
    );
    expect(
      view.querySelector(
        'button[aria-label="Only use providers that support Zero Data Retention."]',
      ),
    ).not.toBeNull();
    await click(privacy);
    expect(privacy.checked).toBe(false);
    expect(view.textContent).toContain("Public Repository Name");
    expect(view.querySelector('[role="tooltip"]')?.textContent?.trim()).toBe(
      "This repository will be public.",
    );

    for (const connection of ["QuickBooks", "Ramp"]) {
      expect(view.textContent).toContain(connection);
    }
    for (const kind of ["quickbooks", "ramp"]) {
      expect(view.querySelector(`[data-kind="${kind}"]`)).not.toBeNull();
    }
    expect(view.querySelector('[data-kind="ramp"] svg')).toBeNull();
    expect(view.textContent).not.toContain("NetSuite");
    expect(view.textContent).not.toContain("Xero");
    expect(view.textContent).not.toContain("Sage Intacct");
    const ramp = view.querySelector<HTMLButtonElement>(
      '[aria-label="Ramp coming soon"]',
    )!;
    expect(ramp.disabled).toBe(true);
    expect(ramp.textContent).toContain("Coming soon");
    await click(
      [...view.querySelectorAll("button")].find(
        (button) => button.textContent === "Show more connections",
      )!,
    );
    for (const connection of ["NetSuite", "Xero", "Sage Intacct"]) {
      const button = view.querySelector<HTMLButtonElement>(
        `[aria-label="${connection} coming soon"]`,
      )!;
      expect(button.disabled).toBe(true);
      expect(button.textContent).toContain("Coming soon");
    }
    expect(view.querySelector('[data-kind="netsuite"] svg')).toBeNull();
    expect(view.querySelector('[aria-label="Add Vercel"]')).toBeNull();

    const connectionSearch = view.querySelector<HTMLInputElement>(
      'input[placeholder="Search connections…"]',
    )!;
    await fill(connectionSearch, "xero");
    expect(view.textContent).toContain("Xero");
    expect(view.textContent).not.toContain("QuickBooks");
  });

  it("runs the connection authorization, configuration, and customization flow", async () => {
    const view = await render(
      <AppBuilder
        authenticated
        user={{ name: "Taylor", email: "taylor@example.com" }}
      />,
    );

    await click(
      view.querySelector<HTMLButtonElement>('[aria-label="Add QuickBooks"]')!,
    );
    expect(view.querySelector("#connection-drawer-title")).toBeNull();
    expect(
      view.querySelector('[aria-label="Added connections"]'),
    ).not.toBeNull();
    expect(
      view.querySelector('[aria-label="Remove QuickBooks"]'),
    ).not.toBeNull();
    expect(
      [...view.querySelectorAll("button")].find(
        (button) => button.textContent === "Connect",
      ),
    ).not.toBeUndefined();

    await click(
      [...view.querySelectorAll("button")].find(
        (button) => button.textContent === "Connect",
      )!,
    );
    expect(view.querySelector("#connection-drawer-title")?.textContent).toBe(
      "Add Connection",
    );
    expect(view.textContent).toContain("Connect QuickBooks");

    const drawerAccessibility = await axe.run(view, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(drawerAccessibility.violations).toEqual([]);

    await click(
      [...view.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("Connect QuickBooks"),
      )!,
    );
    expect(view.textContent).toContain("Connection successful");
    await click(
      [...view.querySelectorAll("button")].find(
        (button) => button.textContent === "Return",
      )!,
    );
    expect(view.textContent).toContain("Connection Name");

    await click(
      [...view.querySelectorAll("button")].find(
        (button) => button.textContent === "Continue",
      )!,
    );
    expect(view.textContent).toContain("Display Name");
    await click(
      [...view.querySelectorAll("button")].find(
        (button) => button.textContent === "Add Connection",
      )!,
    );
    expect(
      view.querySelector('[aria-label="Added connections"]'),
    ).not.toBeNull();
    expect(
      view.querySelector('[aria-label="Remove QuickBooks"]'),
    ).not.toBeNull();
    expect(view.textContent).toContain("Customize");

    await click(
      view.querySelector<HTMLButtonElement>(
        '[aria-label="Remove QuickBooks"]',
      )!,
    );
    expect(view.querySelector('[aria-label="Remove QuickBooks"]')).toBeNull();
    expect(view.querySelector('[aria-label="Add QuickBooks"]')).not.toBeNull();
  });
});
