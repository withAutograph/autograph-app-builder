import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SandboxSession } from "eve/sandbox";
const state = vi.hoisted(() => ({ identity: null as string | null, simulated: false }));
vi.mock("eve/context", () => ({
  defineState: () => ({
    get: () => state.identity,
    update: (change: (id: string | null) => string | null) => {
      state.identity = change(state.identity);
    },
  }),
}));
vi.mock("../testing/test-capability", () => ({ hasTestCapability: () => state.simulated }));
import {
  getBuilderSandboxId,
  setBuilderSandboxNetworkPolicy,
  simulatedSandboxIdentity,
} from "./builder-sandbox";

describe("Builder provider capabilities", () => {
  beforeEach(() => {
    state.identity = null;
    state.simulated = false;
  });
  it("requires connected provider identity and network capability in real sessions", async () => {
    const common = {} as SandboxSession;
    expect(() => getBuilderSandboxId(common)).toThrow("provider identity");
    await expect(setBuilderSandboxNetworkPolicy(common, "allow-all")).rejects.toThrow(
      "credential network policy",
    );
  });
  it("retains synthetic identity across distinct JustBash resume handles", async () => {
    state.simulated = true;
    simulatedSandboxIdentity.update(() => "fixture-session");
    expect(getBuilderSandboxId({} as SandboxSession)).toBe("simulated-fixture-session");
    expect(getBuilderSandboxId({} as SandboxSession)).toBe("simulated-fixture-session");
    await expect(
      setBuilderSandboxNetworkPolicy({} as SandboxSession, "allow-all"),
    ).resolves.toBeUndefined();
  });
});
