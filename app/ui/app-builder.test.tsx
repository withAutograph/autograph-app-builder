/** @vitest-environment jsdom */

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import axe from "axe-core";
import { afterEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  replace: vi.fn(),
}));
const authClientMocks = vi.hoisted(() => ({ signOut: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => navigation,
}));
vi.mock("../../lib/auth-client", () => ({
  authClient: { signOut: authClientMocks.signOut },
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

async function focus(element: HTMLElement) {
  await act(async () => element.focus());
}

async function press(element: HTMLElement, key: string) {
  await act(async () =>
    element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })),
  );
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

  it("cycles app brief examples without repeating the current example", async () => {
    const view = await render(
      <AppBuilder
        authenticated
        user={{ name: "Taylor", email: "taylor@example.com" }}
      />,
    );
    const brief = view.querySelector<HTMLTextAreaElement>("#app-brief")!;
    const anotherExample = view.querySelector<HTMLButtonElement>(
      '[aria-label="Try another app brief example"]',
    )!;
    const examples = [brief.value];

    for (let index = 0; index < 3; index += 1) {
      await click(anotherExample);
      examples.push(brief.value);
    }

    expect(new Set(examples).size).toBe(4);
    await click(anotherExample);
    expect(brief.value).toBe(examples[0]);
  });

  it("selects and searches seeded teams, GitHub scopes, and models", async () => {
    const view = await render(
      <AppBuilder
        authenticated
        user={{ name: "Taylor", email: "taylor@example.com" }}
      />,
    );

    const team = view.querySelector<HTMLInputElement>(
      '[aria-label="Select a Vercel Team"]',
    )!;
    await focus(team);
    expect(view.querySelector('[data-option-value="pylee"]')).not.toBeNull();
    expect(
      view.querySelector('[data-option-value="autograph"]'),
    ).not.toBeNull();
    const createTeam = [
      ...view.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent === "Create a Team")!;
    expect(createTeam.disabled).toBe(true);
    await click(
      view.querySelector<HTMLElement>('[data-option-value="pylee"]')!,
    );
    expect(team.value).toBe("pylee");
    await fill(team, "missing");
    expect(view.textContent).toContain("No results found.");
    await press(team, "Escape");
    expect(team.value).toBe("pylee");

    const gitScope = view.querySelector<HTMLInputElement>(
      '[aria-label="Git Scope"]',
    )!;
    await focus(gitScope);
    await fill(gitScope, "withAuto");
    expect(
      view.querySelector('[data-option-value="withAutograph"]'),
    ).not.toBeNull();
    const addScope = [
      ...view.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent === "Add GitHub Scope")!;
    expect(addScope.disabled).toBe(true);
    await press(gitScope, "Enter");
    expect(gitScope.value).toBe("withAutograph");

    const model = view.querySelector<HTMLInputElement>(
      '[aria-label="GPT 5.6 Terra"]',
    )!;
    await focus(model);
    await fill(model, "openai/gpt-5.4-mini");
    expect(view.textContent).toContain("GPT 5.4 Mini");
    expect(view.textContent).not.toContain("Claude Opus 4.6");
    await press(model, "Enter");
    expect(model.value).toBe("GPT 5.4 Mini");
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

  it("signs out through the JSON auth client and returns to sign in", async () => {
    authClientMocks.signOut.mockResolvedValue({ data: { success: true } });
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
    const logOut = [...view.querySelectorAll("button")].find(
      (button) => button.textContent === "Log Out",
    )!;

    expect(logOut.closest("form")).toBeNull();
    await click(logOut);

    expect(authClientMocks.signOut).toHaveBeenCalledOnce();
    expect(navigation.replace).toHaveBeenCalledWith("/auth/sign-in");
    expect(navigation.refresh).toHaveBeenCalledOnce();
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
    await click(ramp);
    expect(view.querySelector('[aria-label="Added connections"]')).toBeNull();
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
