/** @vitest-environment jsdom */

import { act, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import axe from "axe-core";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.stubEnv("NEXT_PUBLIC_FEATURE_CONNECTIONS", "true");

const navigation = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  replace: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => navigation,
}));
vi.mock("../../components/auth/user/user-button", () => ({
  UserButton: () => <button aria-label="Account">Account</button>,
}));

import {
  appNameFromBrief,
  AppBuilder as AppBuilderComponent,
  repositoryNameFromAppName,
} from "./app-builder";

const integrationState = {
  vercel: {
    status: "connected" as const,
    scopes: [
      {
        installationId: "vercel-pylee",
        status: "connected" as const,
        displayName: "pylee",
        slug: "pylee",
        plan: "Hobby",
      },
      {
        installationId: "vercel-autograph",
        status: "connected" as const,
        displayName: "autograph",
        slug: "autograph",
        plan: "Pro",
      },
    ],
  },
  github: {
    status: "connected" as const,
    scopes: [
      {
        installationId: "101",
        status: "connected" as const,
        accountLogin: "jasonmorganson",
        accountType: "User" as const,
      },
      {
        installationId: "102",
        status: "connected" as const,
        accountLogin: "withAutograph",
        accountType: "Organization" as const,
      },
    ],
  },
  models: {
    status: "ready" as const,
    entries: [
      {
        id: "openai/gpt-5.6-sol",
        name: "GPT 5.6 Sol",
        provider: "openai",
        capabilities: ["tool-use"],
        zdr: "all" as const,
      },
      {
        id: "openai/gpt-5.6-terra",
        name: "GPT 5.6 Terra",
        provider: "openai",
        capabilities: ["tool-use"],
        zdr: "all" as const,
      },
      {
        id: "openai/gpt-5.4-mini",
        name: "GPT 5.4 Mini",
        provider: "openai",
        capabilities: [],
        zdr: "some" as const,
      },
      {
        id: "anthropic/claude-opus-4.6",
        name: "Claude Opus 4.6",
        provider: "anthropic",
        capabilities: [],
        zdr: "none" as const,
      },
    ],
    defaultModelId: "openai/gpt-5.6-terra",
    cached: false,
  },
};

function AppBuilder(
  props: Omit<ComponentProps<typeof AppBuilderComponent>, "integrations"> & {
    user?: { name: string; email: string };
  },
) {
  const { user, ...componentProps } = props;
  void user;
  return (
    <AppBuilderComponent {...componentProps} integrations={integrationState} />
  );
}

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
    expect(
      view.querySelector('a[href="/auth/sign-in?callbackURL=%2F"]')
        ?.textContent,
    ).toBe("Sign In");
    expect(
      view.querySelector('a[href="/auth/sign-up?callbackURL=%2F"]')
        ?.textContent,
    ).toBe("Sign Up");
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
    expect(view.textContent).not.toContain("Vercel Team (Optional)");
    expect(view.textContent).toContain("Git Scope (Optional)");
    expect(view.textContent).toContain("App Name");
    expect(view.textContent).toContain("App Brief");
    expect(view.textContent).toContain("Build with");
    expect(view.textContent).toContain("Store in");
    expect(view.textContent).toContain("Deploy to");
    expect(view.textContent).toContain("Where do you want to build this app?");
    expect(view.textContent).toContain("Where do you want to store this app?");
    expect(view.textContent).toContain("Where do you want to deploy this app?");
    expect(view.textContent).toContain("ChatGPT / Codex");
    expect(view.textContent).toContain("Cursor");
    expect(view.textContent).toContain("Web Chat");
    expect(view.textContent).toContain("Coming soon");
    expect(view.textContent).not.toContain("Zero Data Retention");
    expect(view.textContent).toContain("Connections");
    expect(view.textContent).not.toContain("Channels");
    expect(view.textContent).not.toContain("Agent Name");
    expect(view.querySelector('[aria-label="Settings"]')).toBeNull();
    expect(
      view.querySelector<HTMLTextAreaElement>("#app-brief")?.placeholder,
    ).toBe("Describe the app you want to build…");

    const destinations = [
      ...view.querySelectorAll<HTMLInputElement>(
        'input[name="build-destination"]',
      ),
    ];
    expect(destinations.map((input) => input.value)).toEqual([
      "web",
      "codex",
      "cursor",
    ]);
    expect(destinations[1]?.checked).toBe(true);
    expect(destinations[1]?.required).toBe(true);
    expect(destinations[2]?.checked).toBe(false);
    expect(destinations[2]?.required).toBe(true);
    expect(destinations[0]?.disabled).toBe(true);

    const storageOptions = [
      ...view.querySelectorAll<HTMLInputElement>(
        '[role="group"][aria-label="Storage provider"] input',
      ),
    ];
    const deploymentOptions = [
      ...view.querySelectorAll<HTMLInputElement>(
        '[role="group"][aria-label="Deployment provider"] input',
      ),
    ];
    expect(storageOptions.map((option) => option.value)).toEqual([
      "github",
      "gitlab",
      "bitbucket",
    ]);
    expect(deploymentOptions.map((option) => option.value)).toEqual([
      "vercel",
      "netlify",
      "cloudflare",
    ]);
    expect(storageOptions[0]?.checked).toBe(true);
    expect(deploymentOptions[0]?.checked).toBe(false);
    expect(storageOptions[1]?.disabled).toBe(true);
    expect(deploymentOptions[1]?.disabled).toBe(true);
    expect(
      [...view.querySelectorAll("[data-provider]")].every((option) =>
        Boolean(option.querySelector("svg")),
      ),
    ).toBe(true);
    expect(view.querySelector("#git-scope")).not.toBeNull();
    expect(view.querySelector("#vercel-team")).toBeNull();

    await click(deploymentOptions[0]!);
    expect(deploymentOptions[0]?.checked).toBe(true);
    expect(view.querySelector("#vercel-team")).not.toBeNull();
    expect(view.textContent).not.toContain("Connect to Vercel");
    await click(deploymentOptions[0]!);
    expect(deploymentOptions[0]?.checked).toBe(false);
    expect(view.querySelector("#vercel-team")).toBeNull();

    await click(storageOptions[0]!);
    expect(storageOptions[0]?.checked).toBe(false);
    expect(view.querySelector("#git-scope")).toBeNull();

    const accessibility = await axe.run(view, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(accessibility.violations).toEqual([]);
  });

  it("places model controls directly after Build with for Web Chat only", async () => {
    const resumeKey = "5f526ce7-04dc-47ff-a865-a89155d7d6bc";
    sessionStorage.setItem(
      `autograph-builder-draft:${resumeKey}`,
      JSON.stringify({
        version: 1,
        form: {
          appName: "Web Chat App",
          repository: "web-chat-app",
          brief: "Build this in Web Chat.",
          privateRepository: true,
          buildDestination: "web",
          connections: [],
          modelId: "openai/gpt-5.6-sol",
        },
        team: "",
        gitScope: "",
        model: "openai/gpt-5.6-sol",
        zdrOnly: false,
        showMoreConnections: false,
        search: "",
        connectedConnections: [],
        focusOrigin: "vercel",
        appNameEditedByUser: true,
        repositoryEditedByUser: true,
      }),
    );
    const view = await render(
      <AppBuilderComponent
        authenticated
        providerResumeKey={resumeKey}
        integrations={integrationState}
      />,
    );

    const buildWith = [...view.querySelectorAll("legend")].find(
      (legend) => legend.textContent === "Build with",
    )!;
    const model = [...view.querySelectorAll("legend")].find(
      (legend) => legend.textContent === "Model",
    )!;
    expect(
      buildWith.parentElement!.compareDocumentPosition(model.parentElement!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(view.querySelector('[aria-label="GPT 5.6 Sol"]')).not.toBeNull();
    expect(
      view.querySelector(
        'button[aria-label="Only use providers that support Zero Data Retention."]',
      ),
    ).not.toBeNull();
    expect(
      view.querySelector<HTMLInputElement>('input[name="zdr"]')?.checked,
    ).toBe(false);
    expect(
      view.querySelector<HTMLInputElement>(
        'input[name="build-destination"][value="web"]',
      )?.checked,
    ).toBe(true);
  });

  it("renders unavailable providers as coming soon and preserves callback outcomes", async () => {
    const view = await render(
      <AppBuilderComponent
        authenticated
        integrations={{
          ...integrationState,
          vercel: {
            status: "unavailable",
            scopes: [],
            unavailableReason: "configuration-unavailable",
          },
          github: {
            status: "unavailable",
            scopes: [],
            unavailableReason: "configuration-unavailable",
          },
        }}
        providerNotices={[
          { provider: "vercel", status: "failed" },
          { provider: "github", status: "connected" },
        ]}
      />,
    );

    expect(view.textContent).toContain("Vercel could not be connected");
    expect(view.textContent).toContain("GitHub connected successfully");
    expect(view.textContent).not.toContain(
      "administrator needs to finish provider setup",
    );
    expect(view.textContent).not.toContain("active App Builder workspace");
    expect(
      view.querySelector<HTMLInputElement>(
        'input[name="deployment-provider"][value="vercel"]',
      )?.disabled,
    ).toBe(true);
    expect(
      view.querySelector<HTMLInputElement>(
        'input[name="deployment-provider"][value="vercel"]',
      )?.checked,
    ).toBe(false);
    expect(
      view.querySelector<HTMLInputElement>(
        'input[name="storage-provider"][value="github"]',
      )?.disabled,
    ).toBe(true);
    expect(
      view.querySelector<HTMLInputElement>(
        'input[name="storage-provider"][value="github"]',
      )?.checked,
    ).toBe(false);
    expect(view.querySelector('a[href="/vercel/installations"]')).toBeNull();
    expect(
      [...view.querySelectorAll('a[href="/github/installations"]')].some(
        (link) => link.textContent === "Connect to GitHub",
      ),
    ).toBe(false);

    const accessibility = await axe.run(view, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(accessibility.violations).toEqual([]);
  });

  it("waits to show repository controls until a GitHub scope is available", async () => {
    const view = await render(
      <AppBuilderComponent
        authenticated
        integrations={{
          ...integrationState,
          github: { status: "disconnected", scopes: [] },
        }}
      />,
    );

    expect(view.querySelector("#repository-name")).toBeNull();
    expect(view.querySelector('[aria-label="Private repository"]')).toBeNull();
    expect(view.textContent).not.toContain("Private Repository Name");
    expect(view.textContent).toContain(
      "Connect GitHub and Autograph can create and configure the repository for you.",
    );
  });

  it("only warns before unloading after a user changes the builder form", async () => {
    const view = await render(
      <AppBuilder
        authenticated
        user={{ name: "Taylor", email: "taylor@example.com" }}
      />,
    );

    const beforeEditing = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(beforeEditing);
    expect(beforeEditing.defaultPrevented).toBe(false);

    await fill(
      view.querySelector<HTMLInputElement>("#app-name")!,
      "Changed App",
    );

    const afterEditing = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(afterEditing);
    expect(afterEditing.defaultPrevented).toBe(true);
  });

  it("preserves a builder draft before a first-use provider connection", async () => {
    const resumeKey = "1c7ed773-0aa9-4e32-9e65-6eb36e7b5cc0";
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(resumeKey);
    const view = await render(
      <AppBuilderComponent
        authenticated
        integrations={{
          ...integrationState,
          vercel: { status: "disconnected", scopes: [] },
          github: { status: "disconnected", scopes: [] },
        }}
      />,
    );
    await fill(
      view.querySelector<HTMLInputElement>("#app-name")!,
      "Restored App",
    );
    await fill(
      view.querySelector<HTMLTextAreaElement>("#app-brief")!,
      "# Restored App\n\nKeep this brief through the provider flow.",
    );
    await click(
      view.querySelector<HTMLInputElement>(
        'input[name="deployment-provider"][value="vercel"]',
      )!,
    );
    await click(
      [...view.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent === "Connect to Vercel",
      )!,
    );

    expect(navigation.push).toHaveBeenCalledWith(
      `/vercel/installations?returnTo=%2F&resume=${resumeKey}`,
    );
    expect(
      sessionStorage.getItem(`autograph-builder-draft:${resumeKey}`),
    ).toContain("Restored App");
  });

  it("restores the draft, field focus, and actionable failure after provider return", async () => {
    const resumeKey = "33d5a3b0-64d5-4cf2-b0f7-015ea9ae0b8d";
    sessionStorage.setItem(
      `autograph-builder-draft:${resumeKey}`,
      JSON.stringify({
        version: 1,
        form: {
          appName: "Restored App",
          repository: "restored-app",
          brief: "# Restored App\n\nKeep every field.",
          privateRepository: false,
          channelWeb: true,
          channelSlack: false,
          connections: ["QuickBooks"],
          modelId: "openai/gpt-5.6-sol",
        },
        team: "",
        gitScope: "",
        model: "openai/gpt-5.6-sol",
        zdrOnly: false,
        showMoreConnections: true,
        search: "quick",
        connectedConnections: ["QuickBooks"],
        deploymentProvider: "vercel",
        focusOrigin: "vercel",
        appNameEditedByUser: true,
        repositoryEditedByUser: true,
      }),
    );
    const view = await render(
      <AppBuilderComponent
        authenticated
        providerResumeKey={resumeKey}
        providerNotices={[{ provider: "vercel", status: "failed" }]}
        integrations={integrationState}
      />,
    );
    await act(async () => new Promise(requestAnimationFrame));

    expect(view.querySelector<HTMLInputElement>("#app-name")?.value).toBe(
      "Restored App",
    );
    expect(view.querySelector("#repository-name")).toBeNull();
    expect(view.querySelector<HTMLInputElement>("#vercel-team")).toBe(
      document.activeElement,
    );
    expect(view.textContent).toContain("Vercel could not be connected");
    expect(view.textContent).toContain("QuickBooks");
    expect(
      view.querySelector<HTMLInputElement>(
        'input[name="build-destination"][value="codex"]',
      )?.checked,
    ).toBe(true);
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
    const examples: string[] = [];

    for (let index = 0; index < 4; index += 1) {
      await click(anotherExample);
      examples.push(brief.value);
    }

    expect(new Set(examples).size).toBe(4);
    await click(anotherExample);
    expect(brief.value).toBe(examples[0]);
  });

  it("keeps generated names in sync until the user edits each field", async () => {
    expect(
      appNameFromBrief(
        "# Customer Feedback Portal\n\nLet customers vote on ideas.",
      ),
    ).toBe("Customer Feedback Portal");
    expect(repositoryNameFromAppName("Café & Orders")).toBe("cafe-and-orders");

    sessionStorage.setItem(
      "autograph-app-brief",
      "# Vendor Onboarding\n\nCollect and review vendor details.",
    );
    const view = await render(
      <AppBuilder
        authenticated
        user={{ name: "Taylor", email: "taylor@example.com" }}
      />,
    );
    await act(async () => new Promise(requestAnimationFrame));

    const appName = view.querySelector<HTMLInputElement>("#app-name")!;
    const repository =
      view.querySelector<HTMLInputElement>("#repository-name")!;
    expect(appName.value).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/u);
    expect(repository.value).toBe(repositoryNameFromAppName(appName.value));

    await fill(
      view.querySelector<HTMLTextAreaElement>("#app-brief")!,
      "# Customer Success Hub\n\nHelp customers reach their goals.",
    );
    expect(appName.value).toBe("Customer Success Hub");
    expect(repository.value).toBe("customer-success-hub");

    await fill(appName, "Existing Name");
    expect(repository.value).toBe("existing-name");
    await fill(
      view.querySelector<HTMLTextAreaElement>("#app-brief")!,
      "# A Different Product\n\nDo something else.",
    );
    expect(appName.value).toBe("Existing Name");
    expect(repository.value).toBe("existing-name");

    await fill(appName, "Existing Name");
    await fill(repository, "existing-repository");
    await fill(
      view.querySelector<HTMLTextAreaElement>("#app-brief")!,
      "# One More Product\n\nDo one more thing.",
    );
    expect(appName.value).toBe("Existing Name");
    expect(repository.value).toBe("existing-repository");
  });

  it("updates a generated app name while preserving a user-entered repository", async () => {
    sessionStorage.setItem(
      "autograph-app-brief",
      "# Vendor Onboarding\n\nCollect and review vendor details.",
    );
    const view = await render(
      <AppBuilder
        authenticated
        user={{ name: "Taylor", email: "taylor@example.com" }}
      />,
    );
    await act(async () => new Promise(requestAnimationFrame));

    const appName = view.querySelector<HTMLInputElement>("#app-name")!;
    const repository =
      view.querySelector<HTMLInputElement>("#repository-name")!;
    await fill(repository, "my-existing-repository");
    await fill(
      view.querySelector<HTMLTextAreaElement>("#app-brief")!,
      "# Customer Success Hub\n\nHelp customers reach their goals.",
    );

    expect(appName.value).toBe("Customer Success Hub");
    expect(repository.value).toBe("my-existing-repository");
  });

  it("generates a random app name and matching repository when no brief exists", async () => {
    const view = await render(
      <AppBuilder
        authenticated
        user={{ name: "Taylor", email: "taylor@example.com" }}
      />,
    );

    const appName = view.querySelector<HTMLInputElement>("#app-name")?.value;
    expect(appName).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/u);
    expect(
      view.querySelector<HTMLInputElement>("#repository-name")?.value,
    ).toBe(repositoryNameFromAppName(appName ?? ""));
  });

  it("selects and searches seeded teams, GitHub scopes, and models", async () => {
    const view = await render(
      <AppBuilder
        authenticated
        user={{ name: "Taylor", email: "taylor@example.com" }}
      />,
    );

    await click(
      view.querySelector<HTMLInputElement>(
        'input[name="deployment-provider"][value="vercel"]',
      )!,
    );
    const team = view.querySelector<HTMLInputElement>(
      '[aria-label="Select a Vercel Team"]',
    )!;
    await focus(team);
    expect(
      view.querySelector('[data-option-value="vercel-pylee"]'),
    ).not.toBeNull();
    expect(
      view.querySelector('[data-option-value="vercel-autograph"]'),
    ).not.toBeNull();
    await click(
      view.querySelector<HTMLElement>('[data-option-value="vercel-pylee"]')!,
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
    expect(view.querySelector('[data-option-value="102"]')).not.toBeNull();
    await press(gitScope, "Enter");
    expect(gitScope.value).toBe("withAutograph");
  });

  it("copies the canonical brief and advances through truthful handoff states", async () => {
    vi.useFakeTimers();
    const open = vi.spyOn(window, "open").mockReturnValue(null);
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
    await fill(
      view.querySelector<HTMLTextAreaElement>("#app-brief")!,
      "# Support App\n\nHelp customers resolve support requests.",
    );
    await click(
      [...view.querySelectorAll("button")].find(
        (button) => button.textContent === "Create App",
      )!,
    );

    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining("App Name:\nsupport-app"),
    );
    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining("Use the Autograph App Builder plugin"),
    );
    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining(
        "codex plugin marketplace add withAutograph/marketplace --ref main",
      ),
    );
    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining(
        "Autograph App Builder is ready. Open a fresh Codex task",
      ),
    );
    expect(open).toHaveBeenCalledWith(
      expect.stringMatching(/^codex:\/\/new\?prompt=/u),
      "_blank",
      "noopener,noreferrer",
    );
    const copiedPrompt = writeText.mock.calls[0]?.[0];
    const initialUrl = open.mock.calls[0]?.[0] as string;
    expect(new URL(initialUrl).searchParams.get("prompt")).toBe(copiedPrompt);
    expect(view.textContent).toContain("Handoff");
    expect(view.textContent).toContain("Preparing App Brief");

    for (let index = 0; index < 6; index += 1) {
      await act(async () => vi.advanceTimersByTimeAsync(700));
    }
    expect(view.textContent).toContain("App Brief Ready!");
    expect(view.textContent).toContain("Open in ChatGPT / Codex");
    expect(view.textContent).toContain(
      "codex plugin add app-builder@autograph",
    );
    expect(view.textContent).not.toContain("npx plugins add");
    await click(
      [...view.querySelectorAll("button")].find(
        (button) => button.textContent === "Open in ChatGPT / Codex",
      )!,
    );
    expect(open).toHaveBeenCalledTimes(2);
    expect(open.mock.calls[1]?.[0]).toBe(initialUrl);
    expect(view.textContent).not.toContain("deployed");
  });

  it("opens Cursor when it is selected as the build destination", async () => {
    vi.useFakeTimers();
    const open = vi.spyOn(window, "open").mockReturnValue(null);
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
      view.querySelector<HTMLTextAreaElement>("#app-brief")!,
      "Build a billing dashboard in Cursor.",
    );
    await click(
      view.querySelector<HTMLInputElement>(
        'input[name="build-destination"][value="cursor"]',
      )!,
    );
    await click(
      [...view.querySelectorAll("button")].find(
        (button) => button.textContent === "Create App",
      )!,
    );

    expect(open).toHaveBeenCalledWith(
      expect.stringMatching(
        /^cursor:\/\/anysphere\.cursor-deeplink\/prompt\?text=/u,
      ),
      "_blank",
      "noopener,noreferrer",
    );
    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining("Build a billing dashboard in Cursor."),
    );
    const copiedPrompt = writeText.mock.calls[0]?.[0];
    const initialUrl = open.mock.calls[0]?.[0] as string;
    expect(new URL(initialUrl).searchParams.get("text")).toBe(copiedPrompt);

    for (let index = 0; index < 6; index += 1) {
      await act(async () => vi.advanceTimersByTimeAsync(700));
    }
    expect(view.textContent).toContain("Open in Cursor");
    await click(
      [...view.querySelectorAll("button")].find(
        (button) => button.textContent === "Open in Cursor",
      )!,
    );
    expect(open).toHaveBeenCalledTimes(2);
    expect(open.mock.calls[1]?.[0]).toBe(initialUrl);
  });

  it("keeps the Ready fallback actionable when launching and copying fail", async () => {
    vi.useFakeTimers();
    vi.spyOn(window, "open").mockImplementation(() => {
      throw new Error("Custom protocol blocked");
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error("Denied")) },
    });
    const view = await render(
      <AppBuilder
        authenticated
        user={{ name: "Taylor", email: "taylor@example.com" }}
      />,
    );

    await fill(
      view.querySelector<HTMLTextAreaElement>("#app-brief")!,
      "Build a fallback status test.",
    );
    await click(
      [...view.querySelectorAll("button")].find(
        (button) => button.textContent === "Create App",
      )!,
    );
    for (let index = 0; index < 6; index += 1) {
      await act(async () => vi.advanceTimersByTimeAsync(700));
    }

    expect(view.textContent).toContain("The browser blocked ChatGPT / Codex.");
    expect(view.textContent).toContain("Clipboard access was blocked.");
    expect(view.textContent).toContain("Open in ChatGPT / Codex");
  });

  it("does not launch an encoded prompt that exceeds the URL safety limit", async () => {
    vi.useFakeTimers();
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
    const view = await render(
      <AppBuilder
        authenticated
        user={{ name: "Taylor", email: "taylor@example.com" }}
      />,
    );

    await fill(
      view.querySelector<HTMLTextAreaElement>("#app-brief")!,
      "A".repeat(8_000),
    );
    await click(
      [...view.querySelectorAll("button")].find(
        (button) => button.textContent === "Create App",
      )!,
    );
    for (let index = 0; index < 6; index += 1) {
      await act(async () => vi.advanceTimersByTimeAsync(700));
    }

    expect(open).not.toHaveBeenCalled();
    expect(view.textContent).toContain("This brief is too long to open");
    expect(view.textContent).toContain("Open in ChatGPT / Codex");
  });

  it("renders the Better Auth account trigger without the legacy menu", async () => {
    const view = await render(
      <AppBuilder
        authenticated
        user={{ name: "Taylor", email: "taylor@example.com" }}
      />,
    );
    expect(view.querySelector('[aria-label="Account"]')).not.toBeNull();
    expect(view.textContent).not.toContain("Feedback");
    expect(view.textContent).not.toContain("Changelog");
    expect(view.querySelector('[role="radiogroup"]')).not.toBeNull();
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
    expect(
      view.querySelector('input[name="deployment-provider"][value="vercel"]'),
    ).not.toBeNull();

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
      view
        .querySelector<HTMLDivElement>('[aria-label="Added connections"]')!
        .querySelector<HTMLButtonElement>("button")!,
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
