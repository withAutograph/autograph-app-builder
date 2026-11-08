// @vitest-environment jsdom
import { act } from "react";
import type { ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SavedSessionDestinationForm } from "./saved-session-destination-form";

const actions = { select: vi.fn() };
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const props = {
  appId: "supplier-app",
  enabled: true,
  expected: {
    adapterGeneration: 1,
    adapterSessionId: "original-adapter",
    cancellationRevision: 0,
    checkpointDigest: undefined,
  },
  github: [],
  ready: false,
  request: undefined,
  requestId: "be05a1b9-92d0-4a16-832b-3309a5594244",
  selectable: true,
  sessionId: "original-build",
  submit: actions.select,
  title: "Supplier app",
  vercel: [],
} satisfies ComponentProps<typeof SavedSessionDestinationForm>;
const roots: ReturnType<typeof createRoot>[] = [];
const render = async (value: ComponentProps<typeof SavedSessionDestinationForm>) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(<SavedSessionDestinationForm {...value} />);
    await Promise.resolve();
  });
  return container;
};
afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) {
      root.unmount();
    }
    await Promise.resolve();
  });
  document.body.replaceChildren();
  actions.select.mockReset();
});

describe("saved build destination form", () => {
  it("asks for normal connected providers before allowing creation", async () => {
    const container = await render(props);
    expect(container.textContent).toContain("Store in");
    expect(container.textContent).toContain("Deploy to");
    const button = container.querySelector<HTMLButtonElement>('button[type="submit"]');
    expect(button?.disabled).toBe(true);
    expect(actions.select).not.toHaveBeenCalled();
  });

  it("continues the attached request instead of creating another app after refresh", async () => {
    actions.select.mockResolvedValue({
      message: "Continue the saved destination.",
      status: "pending",
    });
    const request = {
      version: 1 as const,
      requestId: props.requestId,
      appName: props.appId,
      deploymentAccess: "public-app" as const,
      providers: { githubInstallationId: "10", vercelInstallationId: "installation" },
      repository: { name: "supplier-app", private: true },
    };
    const container = await render({ ...props, request, requestId: "unused-new-page-id" });
    const form = container.querySelector("form");
    if (form === null) {
      throw new Error("Expected destination form");
    }
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    expect(actions.select).toHaveBeenCalledWith({
      expected: props.expected,
      request: { ...request, operation: "vercel" },
      sessionId: props.sessionId,
    });
    expect(container.textContent).toContain("Continue the saved destination.");
  });

  it("does not offer another creation after the destination is ready", async () => {
    const container = await render({ ...props, ready: true });
    expect(container.textContent).toContain("destination is ready");
    expect(container.querySelector("form")).toBeNull();
    expect(actions.select).not.toHaveBeenCalled();
  });
});
