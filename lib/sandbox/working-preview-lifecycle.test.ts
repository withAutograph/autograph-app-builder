import hook from "../../agent/hooks/release-sandbox-compute";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HookContext } from "eve/hooks";
import type { WorkingPreviewRuntime } from "./working-preview-runtime";

const state = vi.hoisted(() => ({ preview: null as WorkingPreviewRuntime | null }));

const context = {
  getSandbox: async () => ({ id: "sandbox", stop: vi.fn() }),
  session: { auth: {}, id: "session" },
} satisfies Pick<HookContext, "getSandbox" | "session">;

describe.each([false, true])("preview completion lifecycle hosted=%s", (hosted) => {
  beforeEach(() => {
    state.preview = null;
  });

  it("loads the actual lifecycle hook", () => {
    expect(hook.events["turn.completed"]).toBeTypeOf("function");
  });
});
