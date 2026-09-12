/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
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
  onerror: (() => void) | null = null;

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

  emit(name: "snapshot" | "end", value: unknown) {
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
  vi.clearAllMocks();
});

describe("HandoffProvisioningProgress", () => {
  it("ignores malformed and regressive SSE snapshots, then refreshes once when a newer terminal revision arrives", async () => {
    vi.stubGlobal("EventSource", TestEventSource);
    await render();

    expect(actions.continue).toHaveBeenCalledWith(undefined, { handoffId });
    const stream = TestEventSource.instances[0]!;
    expect(stream.url).toBe(
      `/api/builder/provision/stream?requestId=${encodeURIComponent(requestId)}`,
    );

    await act(async () => stream.malformed("snapshot"));
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

    await act(async () => stream.onerror?.());
    expect(TestEventSource.instances).toHaveLength(1);

    await act(async () => root?.unmount());
    expect(stream.closed).toBe(true);
    root = undefined;
  });
});
