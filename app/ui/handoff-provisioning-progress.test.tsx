// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BuilderProvisionProjection } from "@/lib/provisioning/contracts";
import { HandoffProvisioningProgress } from "./handoff-provisioning-progress";

const navigation = vi.hoisted(() => ({ refresh: vi.fn() }));
const actions = vi.hoisted(() => ({
  continue: vi.fn(async () => ({ status: "updated" as const })),
}));

vi.mock("next/navigation", () => ({ useRouter: () => navigation }));
vi.mock("@/app/actions/builder", () => ({
  continueHandoffProvisioning: actions.continue,
}));

const handoffId = "123e4567-e89b-42d3-a456-426614174001";
const requestId = "123e4567-e89b-42d3-a456-426614174000";

function projection(
  revision: number,
  status: "pending" | "settled" = "pending",
): BuilderProvisionProjection {
  return {
    revision,
    provisioning: {
      version: 1,
      requestId,
      requestDigest: "a".repeat(64),
      appId: "vendor-portal",
      status,
      github: { status: "skipped", code: "not_selected", retryable: false },
      vercel: { status: "skipped", code: "not_selected", retryable: false },
      updatedAt: "2030-01-01T00:00:00.000Z",
    },
  };
}

class TestEventSource {
  static instances: TestEventSource[] = [];
  readonly listeners = new Map<string, Set<(event: MessageEvent<string>) => void>>();
  readonly url: string;
  closed = false;

  constructor(url: string) {
    this.url = url;
    TestEventSource.instances.push(this);
  }

  addEventListener(name: string, listener: (event: MessageEvent<string>) => void) {
    const listeners = this.listeners.get(name) ?? new Set();
    listeners.add(listener);
    this.listeners.set(name, listeners);
  }

  close() {
    this.closed = true;
  }

  emit(name: "snapshot" | "end" | "open" | "error", value?: unknown) {
    const event = new MessageEvent("message", { data: JSON.stringify(value) });
    for (const listener of this.listeners.get(name) ?? []) listener(event);
  }

  malformed(name: "snapshot" | "end") {
    const event = new MessageEvent("message", { data: "not-json" });
    for (const listener of this.listeners.get(name) ?? []) listener(event);
  }
}

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let root: Root | undefined;
let container: HTMLDivElement | undefined;

async function render(initial = projection(1)) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<HandoffProvisioningProgress handoffId={handoffId} initial={initial} />);
  });
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  TestEventSource.instances = [];
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("HandoffProvisioningProgress", () => {
  it("keeps transport rejection inline and retries the same handoff successfully", async () => {
    vi.stubGlobal("EventSource", TestEventSource);
    actions.continue.mockRejectedValueOnce(new Error("connection interrupted"));
    await render();
    expect(container?.textContent).toContain("Provider setup paused. Your handoff is saved.");
    const retry = [...(container?.querySelectorAll("button") ?? [])].find(
      (button) => button.textContent === "Retry provider setup",
    );
    expect(retry).toBeDefined();
    await act(async () => retry?.click());
    expect(actions.continue).toHaveBeenCalledTimes(2);
    expect(actions.continue).toHaveBeenLastCalledWith({ status: "error" }, { handoffId });
    expect(container?.textContent).not.toContain("Provider setup paused");
    expect(container?.textContent).not.toContain("Retry provider setup");
    expect(TestEventSource.instances).toHaveLength(1);
  });

  it("ignores malformed and regressive SSE snapshots, then refreshes once when a newer terminal revision arrives", async () => {
    vi.stubGlobal("EventSource", TestEventSource);
    await render();

    expect(actions.continue).toHaveBeenCalledWith(undefined, { handoffId });
    const stream = TestEventSource.instances[0]!;
    expect(stream.url).toBe(
      `/api/builder/provision/stream?requestId=${encodeURIComponent(requestId)}&afterRevision=1`,
    );

    await act(async () => stream.malformed("snapshot"));
    for (const invalid of [
      { ...projection(99), provisioning: { ...projection(99).provisioning, status: "unexpected" } },
      { ...projection(99), provisioning: { ...projection(99).provisioning, requestId: handoffId } },
      { ...projection(99), provisioning: { ...projection(99).provisioning, github: {} } },
      {
        ...projection(99),
        provisioning: { ...projection(99).provisioning, updatedAt: "yesterday" },
      },
      { ...projection(99), extra: "unexpected" },
      { ...projection(99), revision: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
      await act(async () => stream.emit("snapshot", invalid));
    }
    await act(async () => stream.emit("snapshot", projection(1)));
    expect(container?.textContent).toContain("Preparing your selected providers");

    await act(async () => stream.emit("snapshot", projection(2)));
    expect(container?.textContent).toContain("Preparing your selected providers");
    await act(async () => stream.emit("end", projection(3, "settled")));
    expect(container?.textContent).toContain("Provider setup is complete");
    expect(navigation.refresh).toHaveBeenCalledOnce();

    await act(async () => stream.emit("snapshot", projection(2)));
    await act(async () => stream.emit("end", projection(4, "settled")));
    expect(navigation.refresh).toHaveBeenCalledOnce();
  });

  it("keeps the native EventSource instance open for cursor-preserving reconnects and closes it on unmount", async () => {
    vi.stubGlobal("EventSource", TestEventSource);
    await render();
    const stream = TestEventSource.instances[0]!;

    await act(async () => stream.emit("error"));
    expect(TestEventSource.instances).toHaveLength(1);
    expect(container?.textContent).toContain("Reconnecting… Your handoff is saved.");
    await act(async () => stream.emit("open"));
    expect(container?.textContent).not.toContain("Reconnecting");

    await act(async () => root?.unmount());
    expect(stream.closed).toBe(true);
    root = undefined;
  });

  it("explicitly reconnects from the last accepted revision without retrying provider work", async () => {
    vi.stubGlobal("EventSource", TestEventSource);
    await render();
    const oldStream = TestEventSource.instances[0]!;
    await act(async () => oldStream.emit("snapshot", projection(7)));
    await act(async () => oldStream.emit("error"));
    await act(async () => container?.querySelector<HTMLButtonElement>("button")?.click());
    expect(oldStream.closed).toBe(true);
    expect(TestEventSource.instances).toHaveLength(2);
    const newStream = TestEventSource.instances[1]!;
    expect(newStream.url).toContain("afterRevision=7");
    expect(actions.continue).toHaveBeenCalledOnce();

    // Queued events from the closed connection must not settle the new stream.
    await act(async () => oldStream.emit("end", projection(20, "settled")));
    expect(navigation.refresh).not.toHaveBeenCalled();
    await act(async () => newStream.emit("snapshot", projection(6, "settled")));
    expect(navigation.refresh).not.toHaveBeenCalled();
    await act(async () => newStream.emit("end", projection(8, "settled")));
    expect(navigation.refresh).toHaveBeenCalledOnce();
    expect(newStream.closed).toBe(true);
  });
});
