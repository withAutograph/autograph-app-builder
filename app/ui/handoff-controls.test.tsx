/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildAppHandoffPrompt,
  buildAppHandoffUrl,
  buildCursorInstallUrl,
} from "../../lib/handoff/client";
import { HandoffControls, type HandoffControlData } from "./handoff-controls";

const navigation = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => navigation }));

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
  await act(async () => root?.render(<HandoffControls initial={data} />));
  return container;
}
async function click(text: string) {
  const button = [...container.querySelectorAll("button")].find(
    (element) => element.textContent === text,
  );
  expect(button).toBeDefined();
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
  if (root) await act(async () => root?.unmount());
  root = undefined;
  container?.remove();
  sessionStorage.clear();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.useRealTimers();
  visibility("visible");
});

describe("destination adapters", () => {
  it("creates distinct opaque prompts and round-trips both URL formats", () => {
    for (const destination of ["codex", "cursor"] as const) {
      const prompt = buildAppHandoffPrompt(id, destination);
      const url = new URL(buildAppHandoffUrl(destination, id));
      expect(url.searchParams.get(destination === "codex" ? "prompt" : "text")).toBe(prompt);
      const payload = JSON.parse(prompt.match(/autograph_start with (\{[^\n]+\})\./u)![1]!);
      expect(payload).toEqual({
        handoffId: id,
        clientRequestId: `web-handoff:${id}`,
      });
      expect(prompt).toContain("same Autograph account");
      expect(url.href.length).toBeLessThan(8_000);
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
  it("identifies the canonical endpoint required for the Codex plugin connection", async () => {
    const data = { ...initial, mcpUrl: "https://preview.builder.example/mcp" };
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
      .mockImplementation(async () => Response.json(initial));
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    visibility("hidden");
    await render();
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(request).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    await act(async () => visibility("visible"));
    expect(request).toHaveBeenCalledOnce();
    await click("Open in Codex");
    expect(open).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("Launch requested");
    expect(container.textContent).not.toContain("Continued in your app");
    await act(async () => visibility("hidden"));
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(request).toHaveBeenCalledOnce();
    request.mockImplementation(async () => Response.json({ ...initial, status: "continued" }));
    await act(async () => visibility("visible"));
    expect(container.textContent).toContain("Continued in your app");
    await act(async () => vi.advanceTimersByTimeAsync(20_000));
    expect(request).toHaveBeenCalledTimes(2);
  });
  it("keeps manual copy and retry usable after blocked launch and clipboard failure", async () => {
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
      .mockImplementation(async () => Response.json(data));
    await render(data);
    expect(container.querySelector('a[href*="mcp/install"]')).toBeNull();
    expect(container.textContent).not.toContain("codex plugin");
    request.mockImplementation(async () => Response.json({ ...data, cursorInstallReady: true }));
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(container.querySelector('a[href*="mcp/install"]')?.textContent).toBe(
      "Add Autograph to Cursor",
    );
  });
  it("renews with a stable request ID after a lost response and never provisions or launches", async () => {
    const data = { ...initial, status: "expired" as const };
    let attempts = 0;
    const request = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, options) => {
      if (options?.method !== "POST") return Response.json(data);
      attempts += 1;
      if (attempts === 1) throw new Error("response lost");
      return Response.json({
        version: 1,
        handoffId: renewedId,
        expiresAt: initial.expiresAt,
      });
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
    await act(async () => root?.unmount());
    container.remove();
    await render(data);
    await click("Renew handoff");
    const renewals = request.mock.calls.filter(([, options]) => options?.method === "POST");
    expect(renewals).toHaveLength(2);
    expect(renewals[0]?.[0]).toBe(`/api/builder/handoffs/${id}/renew`);
    expect(renewals[0]?.[1]?.body).toBe(renewals[1]?.[1]?.body);
    expect(request.mock.calls.every(([url]) => !String(url).includes("provision"))).toBe(true);
    expect(navigation.replace).toHaveBeenCalledWith(`/handoff/${renewedId}`);
    expect(open).not.toHaveBeenCalled();
  });
  it.each(["prepared", "continued"] as const)(
    "refreshes a same-ID renewal immediately to %s without requiring a remount",
    async (status) => {
      const expired = { ...initial, status: "expired" as const };
      let renewed = false;
      vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, options) => {
        if (options?.method === "POST") {
          renewed = true;
          return Response.json({
            version: 1,
            handoffId: id,
            expiresAt: "2031-01-01T00:00:00.000Z",
          });
        }
        return Response.json(
          renewed ? { ...initial, status, expiresAt: "2031-01-01T00:00:00.000Z" } : expired,
        );
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
      expect(navigation.refresh).toHaveBeenCalledOnce();
      expect(container.textContent?.includes("Continued in your app")).toBe(status === "continued");
    },
  );
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
      .mockImplementation(async () => Response.json(initial));
    await render();
    expect(container.textContent).toContain("Status is temporarily unavailable");
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(request).toHaveBeenCalledTimes(2);
    expect(container.textContent).not.toContain("Status is temporarily unavailable");
  });
});
