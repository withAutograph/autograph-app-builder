/** @vitest-environment jsdom */

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import axe from "axe-core";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    ...props
  }: {
    children: ReactNode;
    href: string;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

import Home from "../page";
import WorkspacePage from "./page";
import { WorkspaceBrief } from "./workspace-brief";

type ClipboardWriter = (text: string) => Promise<void>;

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement | undefined;

async function render(ui: ReactNode) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(ui);
  });
  return container;
}

async function resetRender(ui: ReactNode) {
  if (root) {
    await act(async () => root?.unmount());
  }
  container?.remove();
  root = undefined;
  container = undefined;
  return render(ui);
}

function setClipboard(writeText: ClipboardWriter) {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
}

async function fill(
  control: HTMLInputElement | HTMLTextAreaElement,
  value: string,
) {
  const prototype =
    control instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const valueSetter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;

  await act(async () => {
    valueSetter?.call(control, value);
    control.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function click(element: HTMLElement) {
  await act(async () => element.click());
}

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
  }
  container?.remove();
  root = undefined;
  container = undefined;
  vi.restoreAllMocks();
});

describe("public App Builder workspace flow", () => {
  it("links the landing route to the workspace route with canonical progress vocabulary", async () => {
    const landing = await render(<Home />);
    const workspaceLink = [...landing.querySelectorAll("a")].find((link) =>
      link.textContent?.includes("Open workspace"),
    );

    expect(workspaceLink?.getAttribute("href")).toBe("/workspace");
    expect(
      landing.querySelector('[aria-label="Autograph App Builder progress"]'),
    ).not.toBeNull();
    expect(landing.textContent).toContain("durable app build");

    const workspace = await resetRender(<WorkspacePage />);
    expect(workspace.querySelector("h1")?.textContent).toBe(
      "Start with a clear brief.",
    );
  });

  it("updates the live preview and copies the exact populated brief", async () => {
    const writeText = vi.fn<ClipboardWriter>().mockResolvedValue(undefined);
    setClipboard(writeText);
    const view = await render(<WorkspaceBrief />);

    await fill(
      view.querySelector<HTMLTextAreaElement>("#objective")!,
      "Create a durable intake flow.",
    );
    await fill(
      view.querySelector<HTMLInputElement>("#repository")!,
      "withAutograph/example",
    );
    await fill(
      view.querySelector<HTMLInputElement>("#constraints")!,
      "Next.js and keyboard accessible",
    );
    await fill(
      view.querySelector<HTMLInputElement>("#doneWhen")!,
      "Unit and browser checks pass",
    );

    const preview = view.querySelector(
      '[aria-label="Autograph App Builder brief preview"]',
    );
    expect(preview?.textContent).toContain("Create a durable intake flow.");
    expect(preview?.textContent).toContain("withAutograph/example");
    expect(preview?.textContent).toContain("Next.js and keyboard accessible");
    expect(preview?.textContent).toContain("Unit and browser checks pass");

    await click(view.querySelector("button")!);

    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText).toHaveBeenCalledWith(
      [
        "Autograph App Builder brief",
        "",
        "Objective:",
        "Create a durable intake flow.",
        "",
        "Repository:",
        "withAutograph/example",
        "",
        "Constraints:",
        "Next.js and keyboard accessible",
        "",
        "Done when:",
        "Unit and browser checks pass",
      ].join("\n"),
    );
    expect(view.querySelector('[role="status"]')?.textContent).toBe(
      "Autograph App Builder brief copied.",
    );
  });

  it("announces clipboard denial without losing the prepared brief", async () => {
    const writeText = vi
      .fn<ClipboardWriter>()
      .mockRejectedValue(new DOMException("Denied", "NotAllowedError"));
    setClipboard(writeText);
    const view = await render(<WorkspaceBrief />);

    await fill(
      view.querySelector<HTMLTextAreaElement>("#objective")!,
      "Preserve this objective.",
    );
    await click(view.querySelector("button")!);

    expect(writeText).toHaveBeenCalledWith(
      [
        "Autograph App Builder brief",
        "",
        "Objective:",
        "Preserve this objective.",
      ].join("\n"),
    );
    expect(view.querySelector('[role="status"]')?.textContent).toBe(
      "Copy isn’t available in this browser.",
    );
    expect(view.textContent).toContain("Preserve this objective.");
  });

  it("gives empty previews screen-reader text and hides only their decorative lines", async () => {
    const view = await render(<WorkspacePage />);
    const sections = view.querySelectorAll(
      '[aria-label="Autograph App Builder brief preview"] > div > section',
    );

    expect(sections).toHaveLength(4);
    expect(
      [...sections].map((section) => section.querySelector("p")?.textContent),
    ).toEqual([
      "Objective appears here",
      "Repository appears here",
      "Constraints appear here",
      "Completion criteria appear here",
    ]);

    for (const section of sections) {
      const skeleton = section.querySelector(":scope > div");
      expect(skeleton?.getAttribute("aria-hidden")).toBe("true");
      expect(skeleton?.hasAttribute("aria-label")).toBe(false);
      expect(section.querySelector("p")?.className).not.toBe("");
    }

    const accessibility = await axe.run(view, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(accessibility.violations).toEqual([]);
  });
});
