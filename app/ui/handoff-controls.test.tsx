// @vitest-environment jsdom

import { act } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildAppHandoffPrompt,
  buildAppHandoffUrl,
  buildCursorInstallUrl,
} from "../../lib/handoff/client";
import { HandoffControls } from "./handoff-controls";
import type { HandoffControlData } from "./handoff-controls";

const navigation = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn() }));
const renewal = vi.hoisted(() => ({ action: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => navigation }));
vi.mock("@/app/actions/handoff-renewal", () => ({
  renewBuilderHandoff: renewal.action,
}));

const id = "123e4567-e89b-42d3-a456-426614174001";
const renewedId = "123e4567-e89b-42d3-a456-426614174002";
const initial: HandoffControlData = {
  version: 1,
  handoffId: id,
  expiresAt: "2030-01-01T00:00:00.000Z",
  status: "prepared",
  destination: "codex",
  cursorInstallReady: true,
  mcpUrl: "https://builder.example/mcp",
};
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
let root: Root | undefined;
let container: HTMLDivElement;
async function render(data = initial) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
  await act(async () => root?.render(<HandoffControls initial={data} />));
  return container;
}
async function click(text: string) {
  const button = [...container.querySelectorAll("button")].find(
    (element) => element.textContent === text,
  );
  expect(button).toBeDefined();
  // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
  await act(async () => button!.click());
}
function visibility(value: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}
afterEach(async () => {
  // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
  if (root) await act(async () => root?.unmount());
  root = undefined;
  container?.remove();
  sessionStorage.clear();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  renewal.action.mockReset();
  vi.useRealTimers();
  visibility("visible");
});

describe("destination adapters", () => {
  it("creates distinct opaque prompts and round-trips both URL formats", () => {
    for (const destination of ["codex", "cursor"] as const) {
      const prompt = buildAppHandoffPrompt(id, destination);
      const url = new URL(buildAppHandoffUrl(destination, id));
      expect(url.searchParams.get(destination === "codex" ? "prompt" : "text")).toBe(prompt);
      const payload = JSON.parse(
        prompt.match(/autograph_start with (?<payload>\{[^\n]+\})\./u)![1]!,
      );
      expect(payload).toEqual({
        handoffId: id,
        clientRequestId: `web-handoff:${id}`,
      });
      expect(prompt).toContain("same Autograph account");
      expect(url.href.length).toBeLessThan(8000);
    }
    expect(buildAppHandoffPrompt(id, "cursor")).not.toContain("codex plugin");
    expect(buildAppHandoffPrompt(id, "codex")).not.toContain("Cursor");
    expect(() => buildAppHandoffPrompt("untrusted prompt", "codex")).toThrow("handoff-id-invalid");
  });
  it("emits only the canonical URL and public client ID when Cursor setup is ready", () => {
    expect(buildCursorInstallUrl(initial.mcpUrl, false)).toBeUndefined();
    const url = new URL(buildCursorInstallUrl(initial.mcpUrl, true)!);
    expect(url.protocol).toBe("cursor:");
    expect(url.pathname).toBe("/mcp/install");
    expect(JSON.parse(atob(url.searchParams.get("config")!))).toEqual({
      url: initial.mcpUrl,
      auth: { CLIENT_ID: "autograph-cursor-desktop" },
    });
    expect(() => buildCursorInstallUrl("https://user:secret@builder.example/mcp", true)).toThrow();
    expect(() => buildCursorInstallUrl("https://builder.example/mcp?token=secret", true)).toThrow();
  });
  it.each(["/", "/mcp/", "/api/mcp", "/other", "/mcp/tools"])(
    "rejects noncanonical MCP pathname %s",
    (pathname) => {
      expect(() => buildCursorInstallUrl(`https://builder.example${pathname}`, true)).toThrow(
        "mcp-url-invalid",
      );
    },
  );
});

describe("durable handoff controls", () => {
  it.each(["prepared", "expired"] as const)(
    "keeps %s browser actions disabled until their handlers hydrate",
    async (status) => {
      let persisted: HandoffControlData = { ...initial, status };
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning fetch mock
      vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json(persisted));
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning action mock
      renewal.action.mockImplementation(async () => {
        persisted = initial;
        return { status: "renewed", handoff: initial };
      });
      const open = vi.spyOn(window, "open").mockReturnValue(null);
      const data = persisted;
      container = document.createElement("div");
      container.innerHTML = renderToString(<HandoffControls initial={data} />);
      document.body.append(container);
      const actionLabel = status === "expired" ? "Renew handoff" : "Open in Codex";
      const button = [...container.querySelectorAll("button")].find(
        (element) => element.textContent === actionLabel,
      )!;
      expect(button.disabled).toBe(true);
      expect(container.querySelector("input")?.matches(":disabled")).toBe(true);
      button.click();
      expect(renewal.action).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning React act callback
      await act(async () => {
        root = hydrateRoot(container, <HandoffControls initial={data} />);
      });
      expect([...container.querySelectorAll("button")]).toContain(button);
      expect(button.disabled).toBe(false);
      await click(actionLabel);
      if (status === "expired") {
        expect(renewal.action).toHaveBeenCalledOnce();
        expect(container.textContent).not.toContain("This handoff has expired");
      } else {
        expect(open).toHaveBeenCalledOnce();
      }
    },
  );

  it("identifies the canonical endpoint required for the Codex plugin connection", async () => {
    const data = { ...initial, mcpUrl: "https://preview.builder.example/mcp" };
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json(data));
    await render(data);
    expect(container.textContent).toContain("Required App Builder connection endpoint:");
    expect(container.textContent).toContain(data.mcpUrl);
    expect(container.textContent).toContain(
      "Before sending, confirm your plugin connection targets this endpoint.",
    );
    expect(container.textContent).toContain(
      "local and Preview handoffs need a matching configured App Builder plugin connection.",
    );
  });
  it("never reports a launch as continuation, and only polls while visible", async () => {
    vi.useFakeTimers();
    const request = vi
      .spyOn(globalThis, "fetch")
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      .mockImplementation(async () => Response.json(initial));
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    visibility("hidden");
    await render();
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(request).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    await act(async () => visibility("visible"));
    expect(request).toHaveBeenCalledOnce();
    await click("Open in Codex");
    expect(open).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("Launch requested");
    expect(container.textContent).not.toContain("Continued in your app");
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    await act(async () => visibility("hidden"));
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(request).toHaveBeenCalledOnce();
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    request.mockImplementation(async () => Response.json({ ...initial, status: "continued" }));
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    await act(async () => visibility("visible"));
    expect(container.textContent).toContain("Continued in your app");
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    await act(async () => vi.advanceTimersByTimeAsync(20_000));
    expect(request).toHaveBeenCalledTimes(2);
  });
  it("keeps manual copy and retry usable after blocked launch and clipboard failure", async () => {
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json(initial));
    vi.spyOn(window, "open").mockImplementation(() => {
      throw new Error("blocked");
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    });
    await render();
    await click("Open in Codex");
    await click("Copy prompt");
    expect(container.textContent).toContain("The browser blocked Codex");
    expect(container.textContent).toContain("Select and copy the prompt below manually");
    expect(container.querySelector("textarea")?.value).toBe(buildAppHandoffPrompt(id));
    expect(container.textContent).not.toContain("Continued in your app");
  });
  it("shows only Cursor setup and hides its install link until registration is ready", async () => {
    vi.useFakeTimers();
    const data = {
      ...initial,
      destination: "cursor" as const,
      cursorInstallReady: false,
    };
    const request = vi
      .spyOn(globalThis, "fetch")
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      .mockImplementation(async () => Response.json(data));
    await render(data);
    expect(container.querySelector('a[href*="mcp/install"]')).toBeNull();
    expect(container.textContent).not.toContain("codex plugin");
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    request.mockImplementation(async () => Response.json({ ...data, cursorInstallReady: true }));
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(container.querySelector('a[href*="mcp/install"]')?.textContent).toBe(
      "Add Autograph to Cursor",
    );
  });
  it("retries a rejected renewal transport with the same request ID and never provisions or launches", async () => {
    const data = { ...initial, status: "expired" as const };
    const request = vi
      .spyOn(globalThis, "fetch")
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      .mockImplementation(async () => Response.json(data));
    renewal.action.mockRejectedValueOnce(new Error("network unavailable")).mockResolvedValueOnce({
      status: "renewed",
      handoff: { ...data, handoffId: renewedId },
    });
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    await render(data);
    expect(
      [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "Open in Codex",
      )?.disabled,
    ).toBe(true);
    await click("Renew handoff");
    expect(container.textContent).toContain("We couldn’t renew this handoff");
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    await act(async () => root?.unmount());
    container.remove();
    await render(data);
    await click("Renew handoff");
    expect(renewal.action).toHaveBeenCalledTimes(2);
    const first = renewal.action.mock.calls[0]?.[1] as { creationRequestId?: string };
    const retry = renewal.action.mock.calls[1]?.[1] as { creationRequestId?: string };
    expect(first).toMatchObject({ handoffId: id });
    expect(first.creationRequestId).toBe(retry.creationRequestId);
    expect(request.mock.calls.every(([url]) => !String(url).includes("provision"))).toBe(true);
    expect(navigation.replace).toHaveBeenCalledWith(`/handoff/${renewedId}`);
    expect(open).not.toHaveBeenCalled();
  });
  it.each(["prepared", "continued"] as const)(
    "reconciles a same-ID renewal immediately to %s without requiring a browser read",
    async (status) => {
      const expired = { ...initial, status: "expired" as const };
      const renewed = { ...initial, status, expiresAt: "2031-01-01T00:00:00.000Z" };
      let persisted = false;
      const request = vi
        .spyOn(globalThis, "fetch")
        // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
        .mockImplementation(async () => Response.json(persisted ? renewed : expired));
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      renewal.action.mockImplementation(async () => {
        persisted = true;
        return {
          status: "renewed",
          handoff: renewed,
        };
      });
      await render(expired);
      await click("Renew handoff");
      expect(container.textContent).not.toContain("This handoff has expired");
      expect(
        [...container.querySelectorAll("button")].find(
          (button) => button.textContent === "Open in Codex",
        )?.disabled,
      ).toBe(false);
      expect(navigation.replace).not.toHaveBeenCalled();
      expect(renewal.action).toHaveBeenCalledOnce();
      expect(request.mock.calls.every(([, options]) => options?.method !== "POST")).toBe(true);
      expect(container.textContent?.includes("Continued in your app")).toBe(status === "continued");
    },
  );
  it("shows the same-account recovery UI when the renewal action loses authorization", async () => {
    const expired = { ...initial, status: "expired" as const };
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json(expired));
    renewal.action.mockResolvedValue({ status: "sign-in" });

    await render(expired);
    await click("Renew handoff");

    expect(container.textContent).toContain("Sign in to continue your saved app");
    expect(container.querySelector("textarea")).toBeNull();
    expect(new URL(container.querySelector("a")!.href).searchParams.get("callbackURL")).toBe(
      `/handoff/${id}`,
    );
  });
  it.each([401, 403, 404])(
    "preserves the continuation path and hides actions on access failure %s",
    async (status) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        Response.json({ error: "unavailable" }, { status }),
      );
      await render();
      const signIn = container.querySelector("a")!;
      expect(new URL(signIn.href).searchParams.get("callbackURL")).toBe(`/handoff/${id}`);
      expect(container.querySelector("textarea")).toBeNull();
      expect(
        [...container.querySelectorAll("button")].find(
          (button) => button.textContent === "Open in Codex",
        )?.disabled,
      ).toBe(true);
    },
  );
  it("recovers from a status outage without asking for provider login", async () => {
    vi.useFakeTimers();
    const request = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      .mockImplementation(async () => Response.json(initial));
    await render();
    expect(container.textContent).toContain("Status is temporarily unavailable");
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(request).toHaveBeenCalledTimes(2);
    expect(container.textContent).not.toContain("Status is temporarily unavailable");
  });
});
