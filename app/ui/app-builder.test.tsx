// @vitest-environment jsdom

import { act } from "react";
import type { ComponentProps, ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import axe from "axe-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appNameFromBrief, repositoryNameFromAppName } from "./builder-defaults";
import { AnonymousBuilder } from "./anonymous-builder";
import { AuthenticatedBuilder as AppBuilderComponent } from "./authenticated-builder";
import { Header } from "./builder-shell";
import * as draftOutbox from "./builder-draft-outbox";
import styles from "./app-builder.module.css";

const navigation = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  replace: vi.fn(),
}));
const builderActions = vi.hoisted(() => ({
  continueBuilderHandoff: vi.fn(),
  // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
  saveActiveBuilderDraft: vi.fn(async (input: { draftId: string; expectedRevision: number }) => ({
    draftId: input.draftId,
    revision: input.expectedRevision + 1,
    updatedAt: "2030-01-01T00:00:00.000Z",
  })),
  // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
  loadActiveBuilderDraft: vi.fn(async () => undefined),
}));

// oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
async function defaultContinuation(
  _previous: unknown,
  input: {
    requestId: string;
    provisioningEnabled: boolean;
  },
) {
  return {
    status: "ready" as const,
    provisioning: {
      version: 1 as const,
      requestId: input.requestId,
      requestDigest: "0".repeat(64),
      appId: "test-app",
      status: "settled" as const,
      github: input.provisioningEnabled
        ? {
            status: "skipped" as const,
            code: (input.provisioningEnabled ? "not_selected" : "feature_disabled") as
              | "not_selected"
              | "feature_disabled",
            retryable: false,
          }
        : {
            status: "skipped" as const,
            code: "not_selected" as const,
            retryable: false,
          },
      vercel: input.provisioningEnabled
        ? {
            status: "skipped" as const,
            code: (input.provisioningEnabled ? "not_selected" : "feature_disabled") as
              | "not_selected"
              | "feature_disabled",
            retryable: false,
          }
        : {
            status: "skipped" as const,
            code: "not_selected" as const,
            retryable: false,
          },
      updatedAt: "2026-08-30T12:00:00.000Z",
    },
    handoff: {
      version: 1 as const,
      handoffId: "123e4567-e89b-42d3-a456-426614174001",
      expiresAt: "2026-09-08T12:00:00.000Z",
    },
  };
}

builderActions.continueBuilderHandoff.mockImplementation(defaultContinuation);
const draftFetch = vi.hoisted(() =>
  // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
  vi.fn(async (_url: string, init?: RequestInit) => {
    const input = JSON.parse(String(init?.body)) as {
      draftId: string;
      expectedRevision: number;
    };
    return Response.json(
      {
        draftId: input.draftId,
        revision: input.expectedRevision + 1,
        updatedAt: "2030-01-01T00:00:00.000Z",
      },
      { status: 200 },
    );
  }),
);

vi.mock("next/navigation", () => ({
  useRouter: () => navigation,
}));
vi.mock("@/app/actions/builder", () => builderActions);
vi.mock("@/app/actions/builder-drafts", () => ({
  loadActiveBuilderDraft: builderActions.loadActiveBuilderDraft,
  saveActiveBuilderDraft: builderActions.saveActiveBuilderDraft,
}));
vi.stubGlobal("fetch", draftFetch);
vi.mock("../../components/auth/user/user-button", () => ({
  UserButton: () => <button aria-label="Account">Account</button>,
}));

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

const opaqueHandoffId = "123e4567-e89b-42d3-a456-426614174001";

function AppBuilder(
  props: Omit<ComponentProps<typeof AppBuilderComponent>, "integrations"> & {
    authenticated?: boolean;
    user?: { name: string; email: string };
  },
) {
  const { user, connectionsEnabled = true, comingSoonEnabled = true, ...componentProps } = props;
  void user;
  if (!componentProps.authenticated) return <AnonymousBuilder />;
  const { authenticated: _authenticated, ...authenticatedProps } = componentProps;
  return (
    <div className={styles.appShell}>
      <Header />
      <AppBuilderComponent
        {...authenticatedProps}
        connectionsEnabled={connectionsEnabled}
        comingSoonEnabled={comingSoonEnabled}
        integrations={integrationState}
        saveActiveBuilderDraftAction={builderActions.saveActiveBuilderDraft}
        loadActiveBuilderDraftAction={builderActions.loadActiveBuilderDraft}
      />
    </div>
  );
}

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let root: Root | undefined;
let container: HTMLDivElement | undefined;

async function render(ui: ReactNode) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
  await act(async () => root?.render(ui));
  return container;
}

async function fill(control: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype =
    control instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
  await act(async () => {
    setter?.call(control, value);
    control.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function click(element: HTMLElement) {
  // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
  await act(async () => element.click());
}

async function focus(element: HTMLElement) {
  // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
  await act(async () => element.focus());
}

async function press(element: HTMLElement, key: string) {
  // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
  await act(async () =>
    element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })),
  );
}

afterEach(async () => {
  vi.useRealTimers();
  // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  sessionStorage.clear();
  vi.restoreAllMocks();
  navigation.push.mockReset();
  navigation.refresh.mockReset();
  navigation.replace.mockReset();
  builderActions.continueBuilderHandoff.mockReset();
  builderActions.continueBuilderHandoff.mockImplementation(defaultContinuation);
  builderActions.loadActiveBuilderDraft.mockReset();
  builderActions.saveActiveBuilderDraft.mockReset();
  draftFetch.mockClear();
});

describe("Vercel-faithful App Builder flow", () => {
  it("hides Coming soon elements by default", async () => {
    const view = await render(<AppBuilderComponent integrations={integrationState} />);

    expect(view.textContent).not.toContain("Coming soon");
    expect(view.textContent).not.toContain("Web Chat");
    expect(view.textContent).not.toContain("Ramp");
  });

  it("renders the anonymous composer with authentication handoff", async () => {
    const view = await render(<AppBuilder authenticated={false} user={{ name: "", email: "" }} />);
    expect(view.querySelector("h1")?.textContent).toBe("Build an app");
    expect(view.textContent).toContain("What should this app do?");
    expect(view.querySelector('a[href="/auth/sign-in?callbackURL=%2F"]')?.textContent).toBe(
      "Sign In",
    );
    expect(view.querySelector('a[href="/auth/sign-up?callbackURL=%2F"]')?.textContent).toBe(
      "Sign Up",
    );
    expect(view.querySelector("button")?.hasAttribute("disabled")).toBe(true);
    expect(view.querySelector("header")?.textContent).toContain("Autograph");

    const suggestion = [...view.querySelectorAll("button")].find(
      (button) => button.textContent === "Build a customer feedback portal",
    );
    expect(suggestion).toBeDefined();
    await click(suggestion!);
    expect(view.querySelector<HTMLTextAreaElement>("#anonymous-brief")?.value).toBe(
      "Build a customer feedback portal",
    );
    expect(
      [...view.querySelectorAll("button")].find((button) => button.textContent === "Continue")
        ?.disabled,
    ).toBe(false);
  });

  it("hides Connections when the server feature flag is disabled", async () => {
    const view = await render(
      <AppBuilder
        authenticated
        connectionsEnabled={false}
        user={{ name: "Taylor", email: "taylor@example.com" }}
      />,
    );

    expect(view.textContent).not.toContain("Connections");
    expect(view.querySelector('[name="connection-search"]')).toBeNull();
  });

  it("shows Connections when the server feature flag is enabled", async () => {
    const view = await render(
      <AppBuilder
        authenticated
        connectionsEnabled
        user={{ name: "Taylor", email: "taylor@example.com" }}
      />,
    );

    expect(view.textContent).toContain("Connections");
    expect(view.querySelector('[name="connection-search"]')).not.toBeNull();
  });

  it("keeps the approved field substitutions and Vercel control order", async () => {
    const view = await render(
      <AppBuilder authenticated user={{ name: "Taylor", email: "taylor@example.com" }} />,
    );
    expect(view.querySelector("h1")?.textContent).toBe("Build an app");
    expect(view.textContent).not.toContain("Vercel Team (Optional)");
    expect(view.textContent).not.toContain(
      "Connect Vercel and Autograph can create and deploy the project for you.",
    );
    expect(view.textContent).toContain("Git Scope");
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
    expect(
      Array.from(
        view.querySelectorAll<HTMLElement>("[data-create-app-section]"),
        (section) => section.dataset.createAppSection,
      ),
    ).toEqual(["app-details", "build-with", "store-in", "deploy-to", "connections"]);
    expect(
      Array.from(
        view.querySelectorAll<HTMLElement>('[role="heading"][aria-level="2"]'),
        (heading) => heading.textContent,
      ),
    ).toEqual(["Build with", "Store in", "Deploy to", "Connections"]);
    expect(view.querySelector('[aria-label="Settings"]')).toBeNull();
    expect(view.querySelector<HTMLTextAreaElement>("#app-brief")?.placeholder).toBe(
      "Describe the app you want to build…",
    );

    const destinations = [
      ...view.querySelectorAll<HTMLInputElement>('input[name="build-destination"]'),
    ];
    expect(destinations.map((input) => input.value)).toEqual(["web", "codex", "cursor"]);
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
    expect(storageOptions.map((option) => option.value)).toEqual(["github", "gitlab", "bitbucket"]);
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
    const view = await render(
      <AppBuilderComponent
        comingSoonEnabled
        integrations={integrationState}
        initialDurableDraft={{
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
        }}
      />,
    );

    const buildWith = [...view.querySelectorAll("legend")].find(
      (legend) => legend.textContent === "Build with",
    )!;
    const model = [...view.querySelectorAll("legend")].find(
      (legend) => legend.textContent === "Model",
    )!;
    expect(
      // oxlint-disable-next-line eslint/no-bitwise -- Intentional bitmask or binary-flag operation.
      buildWith.parentElement!.compareDocumentPosition(model.parentElement!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(view.querySelector('[aria-label="GPT 5.6 Terra"]')).not.toBeNull();
    expect(
      view.querySelector(
        'button[aria-label="Only use providers that support Zero Data Retention."]',
      ),
    ).not.toBeNull();
    expect(view.querySelector<HTMLInputElement>('input[name="zdr"]')?.checked).toBe(false);
    expect(
      view.querySelector<HTMLInputElement>('input[name="build-destination"][value="web"]')?.checked,
    ).toBe(true);
  });

  it("renders unavailable providers as coming soon and preserves callback outcomes", async () => {
    const view = await render(
      <AppBuilderComponent
        comingSoonEnabled
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
    expect(view.textContent).not.toContain("administrator needs to finish provider setup");
    expect(view.textContent).not.toContain("active App Builder workspace");
    expect(
      view.querySelector<HTMLInputElement>('input[name="deployment-provider"][value="vercel"]')
        ?.disabled,
    ).toBe(true);
    expect(
      view.querySelector<HTMLInputElement>('input[name="deployment-provider"][value="vercel"]')
        ?.checked,
    ).toBe(false);
    expect(
      view.querySelector<HTMLInputElement>('input[name="storage-provider"][value="github"]')
        ?.disabled,
    ).toBe(true);
    expect(
      view.querySelector<HTMLInputElement>('input[name="storage-provider"][value="github"]')
        ?.checked,
    ).toBe(false);
    expect(view.querySelector('a[href="/vercel/installations"]')).toBeNull();
    expect(
      [...view.querySelectorAll('a[href="/github/installations"]')].some(
        (link) => link.textContent === "Connect GitHub",
      ),
    ).toBe(false);

    const accessibility = await axe.run(view, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(accessibility.violations).toEqual([]);
  });

  it("keeps GitHub failures out of the shared provider notice area", async () => {
    const view = await render(
      <AppBuilderComponent
        connectionsEnabled
        integrations={integrationState}
        providerNotices={[{ provider: "github", status: "failed", reason: "callback-invalid" }]}
      />,
    );

    expect(view.textContent).not.toContain("GitHub could not be connected");
    expect(view.querySelector('[role="alert"]')).toBeNull();
  });

  it("waits to show repository controls until a GitHub scope is available", async () => {
    const view = await render(
      <AppBuilderComponent
        integrations={{
          ...integrationState,
          github: { status: "disconnected", scopes: [] },
        }}
      />,
    );

    expect(view.querySelector("#repository-name")).toBeNull();
    expect(view.querySelector('[aria-label="Private repository"]')).toBeNull();
    expect(view.textContent).not.toContain("Private Repository Name");
    expect(view.textContent).not.toContain(
      "Connect GitHub and Autograph can create and configure the repository for you.",
    );
  });

  it("never blocks unloading after a user changes the builder form", async () => {
    const view = await render(
      <AppBuilder authenticated user={{ name: "Taylor", email: "taylor@example.com" }} />,
    );

    const beforeEditing = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(beforeEditing);
    expect(beforeEditing.defaultPrevented).toBe(false);

    await fill(view.querySelector<HTMLInputElement>("#app-name")!, "Changed App");

    const afterEditing = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(afterEditing);
    expect(afterEditing.defaultPrevented).toBe(false);
  });

  it("autosaves the latest form revision after editing", async () => {
    vi.useFakeTimers();
    const view = await render(
      <AppBuilder authenticated user={{ name: "Taylor", email: "taylor@example.com" }} />,
    );

    await fill(view.querySelector<HTMLTextAreaElement>("#app-brief")!, "Keep this draft.");
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    await act(async () => vi.advanceTimersByTimeAsync(500));

    expect(builderActions.saveActiveBuilderDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedRevision: 0,
        record: expect.objectContaining({
          draft: expect.objectContaining({
            form: expect.objectContaining({ brief: "Keep this draft." }),
          }),
        }),
      }),
    );
    expect(view.textContent).toContain("Draft saved");
  });

  it("does not autosave an untouched hydrated builder", async () => {
    vi.useFakeTimers();
    await render(
      <AppBuilder authenticated user={{ name: "Taylor", email: "taylor@example.com" }} />,
    );

    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    await act(async () => vi.advanceTimersByTimeAsync(1000));

    expect(builderActions.saveActiveBuilderDraft).not.toHaveBeenCalled();
  });

  it("claims an anonymous brief without another edit and clears it only after acknowledgement", async () => {
    vi.useFakeTimers();
    sessionStorage.setItem("autograph-app-brief", "Claim this anonymous brief.");
    const saved = Promise.withResolvers<{ draftId: string; revision: number; updatedAt: string }>();
    builderActions.saveActiveBuilderDraft.mockImplementationOnce(() => saved.promise);
    await render(<AppBuilder authenticated />);
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    await act(async () => vi.advanceTimersToNextFrame());
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(builderActions.saveActiveBuilderDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        record: expect.objectContaining({
          draft: expect.objectContaining({
            form: expect.objectContaining({ brief: "Claim this anonymous brief." }),
          }),
        }),
      }),
    );
    expect(sessionStorage.getItem("autograph-app-brief")).toBe("Claim this anonymous brief.");
    const [[request]] = builderActions.saveActiveBuilderDraft.mock.calls;
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    await act(async () =>
      saved.resolve({
        draftId: request.draftId,
        revision: 1,
        updatedAt: "2030-01-01T00:00:00.000Z",
      }),
    );
    expect(sessionStorage.getItem("autograph-app-brief")).toBeNull();
  });

  it("replaces locally edited RHF values with a newer server revision", async () => {
    const view = await render(
      <AppBuilder
        authenticated
        user={{ name: "Taylor", email: "taylor@example.com" }}
        durableDraftId="d1210e56-ded0-436d-a6b8-ae96ddec17e0"
        durableDraftRevision={1}
      />,
    );
    const brief = view.querySelector<HTMLTextAreaElement>("#app-brief")!;
    await fill(brief, "This local edit will be replaced.");
    builderActions.loadActiveBuilderDraft.mockResolvedValueOnce({
      draftId: "d1210e56-ded0-436d-a6b8-ae96ddec17e0",
      // Hiding the document also checkpoints this device's edit at revision 2.
      // The other device's completed snapshot must have a newer revision.
      revision: 3,
      updatedAt: "2030-01-01T00:00:03.000Z",
      record: {
        version: 1,
        draft: {
          version: 1,
          form: {
            appName: "Remote App",
            repository: "remote-app",
            brief: "Saved on another device.",
            privateRepository: true,
            buildDestination: "codex",
            connections: [],
            modelId: "openai/gpt-5.6-sol",
          },
          team: "vercel-pylee",
          gitScope: "101",
          model: "openai/gpt-5.6-sol",
          zdrOnly: false,
          showMoreConnections: false,
          search: "",
          connectedConnections: [],
          storageProvider: "github",
          deploymentProvider: null,
          focusOrigin: "github",
          appNameEditedByUser: false,
          repositoryEditedByUser: false,
        },
      },
    } as never);
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    await act(async () => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "hidden",
      });
      document.dispatchEvent(new Event("visibilitychange"));
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "visible",
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    await act(async () => undefined);

    expect(brief.value).toBe("Saved on another device.");
    expect(view.textContent).toContain("Updated from another device");
  });

  it("does not apply an older remote revision after a newer revision settles", async () => {
    const delayedRead = Promise.withResolvers<undefined>();
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    const read = vi.fn(async () => undefined);
    vi.spyOn(draftOutbox, "createBuilderDraftOutbox").mockReturnValue({
      read,
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      write: async () => undefined,
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      clear: async () => undefined,
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      clearIfMutationId: async () => true,
    });
    const draft = {
      version: 1 as const,
      form: {
        appName: "Initial",
        repository: "initial",
        brief: "Initial brief",
        privateRepository: true,
        buildDestination: "codex" as const,
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
      storageProvider: null,
      deploymentProvider: null,
      focusOrigin: "github" as const,
      appNameEditedByUser: true,
      repositoryEditedByUser: false,
    };
    const page = (revision: number) => (
      <AppBuilder
        authenticated
        durableDraftId="d1210e56-ded0-436d-a6b8-ae96ddec17e0"
        durableDraftRevision={revision}
        durableDraftUpdatedAt={`2030-01-01T00:00:0${revision}.000Z`}
        initialDurableDraft={{
          ...draft,
          form: { ...draft.form, appName: `Revision ${revision}` },
        }}
      />
    );
    const view = await render(page(1));
    read.mockImplementationOnce(() => delayedRead.promise);
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    await act(async () => root?.render(page(2)));
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    await act(async () => root?.render(page(3)));
    expect(view.querySelector<HTMLInputElement>("#app-name")!.value).toBe("Revision 3");
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    await act(async () => delayedRead.resolve(undefined));
    expect(view.querySelector<HTMLInputElement>("#app-name")!.value).toBe("Revision 3");
  });

  it("does not replace newer edits with its own in-flight autosave", async () => {
    vi.useFakeTimers();
    let resolveSave!: (saved: { draftId: string; revision: number; updatedAt: string }) => void;
    builderActions.saveActiveBuilderDraft.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSave = resolve;
        }),
    );
    const view = await render(
      <AppBuilder authenticated user={{ name: "Taylor", email: "taylor@example.com" }} />,
    );
    const brief = view.querySelector<HTMLTextAreaElement>("#app-brief")!;
    await fill(brief, "First local edit.");
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    await act(async () => vi.advanceTimersByTimeAsync(500));
    await fill(brief, "Newer local edit.");

    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    await act(async () => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "hidden",
      });
      document.dispatchEvent(new Event("visibilitychange"));
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "visible",
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(builderActions.loadActiveBuilderDraft).not.toHaveBeenCalled();
    expect(brief.value).toBe("Newer local edit.");

    await act(async () => {
      resolveSave({
        draftId: "d1210e56-ded0-436d-a6b8-ae96ddec17e0",
        revision: 1,
        updatedAt: "2030-01-01T00:00:01.000Z",
      });
      await Promise.resolve();
    });
  });

  it("cycles app brief examples without repeating the current example", async () => {
    const view = await render(
      <AppBuilder authenticated user={{ name: "Taylor", email: "taylor@example.com" }} />,
    );
    const brief = view.querySelector<HTMLTextAreaElement>("#app-brief")!;
    const anotherExample = view.querySelector<HTMLButtonElement>(
      '[aria-label="Try another app brief example"]',
    )!;
    const examples: string[] = [];

    for (let index = 0; index < 4; index += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
      await click(anotherExample);
      examples.push(brief.value);
    }

    expect(new Set(examples).size).toBe(4);
    await click(anotherExample);
    expect(brief.value).toBe(examples[0]);
  });

  it("keeps generated names in sync until the user edits each field", async () => {
    expect(appNameFromBrief("# Customer Feedback Portal\n\nLet customers vote on ideas.")).toBe(
      "Customer Feedback Portal",
    );
    expect(repositoryNameFromAppName("Café & Orders")).toBe("cafe-and-orders");
    expect(appNameFromBrief("x".repeat(8100))).toHaveLength(120);

    sessionStorage.setItem(
      "autograph-app-brief",
      "# Vendor Onboarding\n\nCollect and review vendor details.",
    );
    const view = await render(
      <AppBuilder authenticated user={{ name: "Taylor", email: "taylor@example.com" }} />,
    );
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    await act(async () => new Promise(requestAnimationFrame));

    const appName = view.querySelector<HTMLInputElement>("#app-name")!;
    const repository = view.querySelector<HTMLInputElement>("#repository-name")!;
    expect(appName.value).toBe("Vendor Onboarding");
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
      <AppBuilder authenticated user={{ name: "Taylor", email: "taylor@example.com" }} />,
    );
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    await act(async () => new Promise(requestAnimationFrame));

    const appName = view.querySelector<HTMLInputElement>("#app-name")!;
    const repository = view.querySelector<HTMLInputElement>("#repository-name")!;
    await fill(repository, "my-existing-repository");
    await fill(
      view.querySelector<HTMLTextAreaElement>("#app-brief")!,
      "# Customer Success Hub\n\nHelp customers reach their goals.",
    );

    expect(appName.value).toBe("Customer Success Hub");
    expect(repository.value).toBe("my-existing-repository");
  });

  it("generates an actionable brief and matching identity when no brief exists", async () => {
    const view = await render(
      <AppBuilder
        authenticated
        generatedNameSeed="request-stable-seed"
        user={{ name: "Taylor", email: "taylor@example.com" }}
      />,
    );

    const brief = view.querySelector<HTMLTextAreaElement>("#app-brief")?.value;
    const appName = view.querySelector<HTMLInputElement>("#app-name")?.value;
    expect(brief).toContain("Build a focused app");
    expect(appName).toBe("Product");
    expect(view.querySelector<HTMLInputElement>("#repository-name")?.value).toBe(
      repositoryNameFromAppName(appName ?? ""),
    );
    expect(
      [...view.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent === "Create App",
      )?.disabled,
    ).toBe(false);
  });

  it("infers optional identity fields but blocks a missing brief or invalid explicit name", async () => {
    const view = await render(
      <AppBuilder authenticated user={{ name: "Taylor", email: "taylor@example.com" }} />,
    );
    const appName = view.querySelector<HTMLInputElement>("#app-name")!;
    const repository = view.querySelector<HTMLInputElement>("#repository-name")!;
    const brief = view.querySelector<HTMLTextAreaElement>("#app-brief")!;
    const create = [...view.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Create App",
    )!;

    await fill(appName, "");
    await fill(repository, "");
    expect(create.disabled).toBe(false);

    await fill(appName, "123 only");
    expect(create.disabled).toBe(true);

    await fill(appName, "");
    await fill(brief, "");
    expect(create.disabled).toBe(true);
  });

  it("does not replace an edited generated name after the builder mounts", async () => {
    const view = await render(
      <AppBuilder
        authenticated
        generatedNameSeed="request-stable-seed"
        user={{ name: "Taylor", email: "taylor@example.com" }}
      />,
    );
    const appName = view.querySelector<HTMLInputElement>("#app-name")!;

    await fill(appName, "Replay Draft");
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    await act(async () => new Promise(requestAnimationFrame));

    expect(appName.value).toBe("Replay Draft");
  });

  it("selects and searches seeded teams, GitHub scopes, and models", async () => {
    const view = await render(
      <AppBuilder authenticated user={{ name: "Taylor", email: "taylor@example.com" }} />,
    );

    await click(
      view.querySelector<HTMLInputElement>('input[name="deployment-provider"][value="vercel"]')!,
    );
    const team = view.querySelector<HTMLInputElement>('[aria-label="Select a Vercel Team"]')!;
    await focus(team);
    expect(view.querySelector('[data-option-value="vercel-pylee"]')).not.toBeNull();
    expect(view.querySelector('[data-option-value="vercel-autograph"]')).not.toBeNull();
    await click(view.querySelector<HTMLElement>('[data-option-value="vercel-pylee"]')!);
    expect(team.value).toBe("pylee");
    await fill(team, "missing");
    expect(view.textContent).toContain("No results found.");
    await press(team, "Escape");
    expect(team.value).toBe("pylee");

    const gitScope = view.querySelector<HTMLInputElement>('[aria-label="Git Scope"]')!;
    await focus(gitScope);
    await fill(gitScope, "withAuto");
    expect(view.querySelector('[data-option-value="102"]')).not.toBeNull();
    await press(gitScope, "Enter");
    expect(gitScope.value).toBe("withAutograph");
  });

  it("continues the durable handoff and routes to its server page", async () => {
    const view = await render(
      <AppBuilder authenticated user={{ name: "Taylor", email: "taylor@example.com" }} />,
    );

    await fill(view.querySelector<HTMLInputElement>("#app-name")!, "support-app");
    await fill(view.querySelector<HTMLInputElement>("#repository-name")!, "support-app");
    await fill(
      view.querySelector<HTMLTextAreaElement>("#app-brief")!,
      "# Support App\n\nHelp customers resolve support requests.",
    );
    await click(
      [...view.querySelectorAll("button")].find((button) => button.textContent === "Create App")!,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(builderActions.continueBuilderHandoff).toHaveBeenCalledOnce();
    expect(builderActions.continueBuilderHandoff).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({
        version: 1,
        provisioningEnabled: false,
        creationRequestId: expect.any(String),
        requestId: expect.any(String),
        draftCheckpoint: { draftId: expect.any(String), revision: expect.any(Number) },
      }),
    );
    expect(navigation.replace).toHaveBeenCalledWith(`/handoff/${opaqueHandoffId}`);
    expect(view.textContent).not.toContain("App Brief Ready!");
    expect(view.textContent).not.toContain("Open in ChatGPT / Codex");
  });

  it("keeps the edited form mounted through a failed continuation and retries the same intent", async () => {
    const continuation = Promise.withResolvers<{ status: "error" }>();
    builderActions.continueBuilderHandoff.mockImplementationOnce(() => continuation.promise);
    const view = await render(<AppBuilder authenticated />);
    const brief = view.querySelector<HTMLTextAreaElement>("#app-brief")!;
    await fill(brief, "Do not lose this saved intent.");
    const form = view.querySelector("form")!;
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(builderActions.continueBuilderHandoff).toHaveBeenCalledOnce();
    expect(view.querySelector("#app-brief")).toBe(brief);
    expect(view.querySelector("main")!.hasAttribute("inert")).toBe(true);
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(builderActions.continueBuilderHandoff).toHaveBeenCalledOnce();
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    await act(async () => continuation.resolve({ status: "error" }));
    expect(view.querySelector("#app-brief")).toBe(brief);
    expect(brief.value).toBe("Do not lose this saved intent.");
    expect(view.querySelector("main")!.hasAttribute("inert")).toBe(false);
    expect(navigation.replace).not.toHaveBeenCalled();
    const [[, first]] = builderActions.continueBuilderHandoff.mock.calls;
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(builderActions.continueBuilderHandoff).toHaveBeenCalledTimes(2);
    expect(builderActions.continueBuilderHandoff.mock.calls[1][1]).toMatchObject({
      requestId: first.requestId,
      creationRequestId: first.creationRequestId,
      draftCheckpoint: { draftId: first.draftCheckpoint.draftId },
    });
    expect(navigation.replace).toHaveBeenCalledWith(`/handoff/${opaqueHandoffId}`);
  });

  it("recovers a lost handoff response without resaving its archived draft", async () => {
    builderActions.continueBuilderHandoff.mockRejectedValueOnce(new Error("response interrupted"));
    const view = await render(<AppBuilder authenticated />);
    const brief = view.querySelector<HTMLTextAreaElement>("#app-brief")!;
    await fill(brief, "Already saved before the response was lost.");
    await click(
      [...view.querySelectorAll("button")].find((button) => button.textContent === "Create App")!,
    );
    expect(view.querySelector("#app-brief")).toBe(brief);
    expect(view.textContent).toContain("Retry saved handoff");
    const saves = builderActions.saveActiveBuilderDraft.mock.calls.length;
    const [[, checkpoint]] = builderActions.continueBuilderHandoff.mock.calls;
    builderActions.saveActiveBuilderDraft.mockRejectedValueOnce(
      new Error("builder-draft-archived"),
    );
    await click(
      [...view.querySelectorAll("button")].find(
        (button) => button.textContent === "Retry saved handoff",
      )!,
    );
    expect(builderActions.saveActiveBuilderDraft).toHaveBeenCalledTimes(saves);
    expect(builderActions.continueBuilderHandoff.mock.calls[1][1]).toEqual(checkpoint);
    expect(navigation.replace).toHaveBeenCalledWith(`/handoff/${opaqueHandoffId}`);
  });

  it("renders the Better Auth account trigger without the legacy menu", async () => {
    const view = await render(
      <AppBuilder authenticated user={{ name: "Taylor", email: "taylor@example.com" }} />,
    );
    expect(view.querySelector('[aria-label="Account"]')).not.toBeNull();
    expect(view.textContent).not.toContain("Feedback");
    expect(view.textContent).not.toContain("Changelog");
    expect(view.querySelector('[role="radiogroup"]')).not.toBeNull();
  });

  it("matches the repository privacy and connection-browser interactions", async () => {
    const view = await render(
      <AppBuilder authenticated user={{ name: "Taylor", email: "taylor@example.com" }} />,
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
    const ramp = view.querySelector<HTMLButtonElement>('[aria-label="Ramp coming soon"]')!;
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
    expect(view.querySelector('input[name="deployment-provider"][value="vercel"]')).not.toBeNull();

    const connectionSearch = view.querySelector<HTMLInputElement>(
      'input[placeholder="Search connections…"]',
    )!;
    await fill(connectionSearch, "xero");
    expect(view.textContent).toContain("Xero");
    expect(view.textContent).not.toContain("QuickBooks");
  });

  it("runs the connection authorization, configuration, and customization flow", async () => {
    const view = await render(
      <AppBuilder authenticated user={{ name: "Taylor", email: "taylor@example.com" }} />,
    );

    await click(view.querySelector<HTMLButtonElement>('[aria-label="Add QuickBooks"]')!);
    expect(view.querySelector("#connection-drawer-title")).toBeNull();
    expect(view.querySelector('[aria-label="Added connections"]')).not.toBeNull();
    expect(view.querySelector('[aria-label="Remove QuickBooks"]')).not.toBeNull();
    expect(
      [...view.querySelectorAll("button")].find((button) => button.textContent === "Connect"),
    ).not.toBeUndefined();

    await click(
      view
        .querySelector<HTMLDivElement>('[aria-label="Added connections"]')!
        .querySelector<HTMLButtonElement>("button")!,
    );
    expect(view.querySelector("#connection-drawer-title")?.textContent).toBe("Add Connection");
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
      [...view.querySelectorAll("button")].find((button) => button.textContent === "Return")!,
    );
    expect(view.textContent).toContain("Connection Name");

    await click(
      [...view.querySelectorAll("button")].find((button) => button.textContent === "Continue")!,
    );
    expect(view.textContent).toContain("Display Name");
    await click(
      [...view.querySelectorAll("button")].find(
        (button) => button.textContent === "Add Connection",
      )!,
    );
    expect(view.querySelector('[aria-label="Added connections"]')).not.toBeNull();
    expect(view.querySelector('[aria-label="Remove QuickBooks"]')).not.toBeNull();
    expect(view.textContent).toContain("Customize");

    await click(view.querySelector<HTMLButtonElement>('[aria-label="Remove QuickBooks"]')!);
    expect(view.querySelector('[aria-label="Remove QuickBooks"]')).toBeNull();
    expect(view.querySelector('[aria-label="Add QuickBooks"]')).not.toBeNull();
  });
});
