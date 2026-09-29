import {
  getBuilderSandboxId,
  setBuilderSandboxNetworkPolicy,
  simulatedSandboxIdentity,
} from "./builder-sandbox";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SandboxSession } from "eve/sandbox";

const state = vi.hoisted(() => {
  interface FixtureState {
    identity: string | null;
    simulated: boolean;
  }
  const value: FixtureState = { identity: null, simulated: false };
  return value;
});
// oxlint-disable-next-line anti-slop/no-module-mocking -- A public context slot is the terminal boundary; no runtime implementation is mocked.
vi.mock("eve/context", () => ({
  defineState: () => ({
    get: () => state.identity,
    update: (change: (id: string | null) => string | null) => {
      state.identity = change(state.identity);
    },
  }),
}));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Exercise the existing brokered fixture boundary without granting real test authority.
vi.mock("../testing/test-capability", () => ({ hasTestCapability: () => state.simulated }));

const fixture = (): SandboxSession => ({
  readBinaryFile: async () => await Promise.resolve(null),
  readFile: async () => await Promise.resolve(null),
  readTextFile: async () => await Promise.resolve(null),
  removePath: async () => {
    await Promise.resolve();
  },
  resolvePath: (path) => path,
  run: async () => await Promise.resolve({ exitCode: 0, stderr: "", stdout: "" }),
  spawn: async () => {
    await Promise.resolve();
    throw new Error("Not used by identity fixture");
  },
  writeBinaryFile: async () => {
    await Promise.resolve();
  },
  writeFile: async () => {
    await Promise.resolve();
  },
  writeTextFile: async () => {
    await Promise.resolve();
  },
});

describe("Builder provider capabilities", () => {
  beforeEach(() => {
    state.identity = null;
    state.simulated = false;
  });
  it("requires connected provider identity and network capability in real sessions", async () => {
    const common = fixture();
    expect(() => getBuilderSandboxId(common)).toThrow("provider identity");
    await expect(setBuilderSandboxNetworkPolicy(common, "allow-all")).rejects.toThrow(
      "credential network policy",
    );
  });
  it("retains synthetic identity across distinct JustBash resume handles", async () => {
    state.simulated = true;
    simulatedSandboxIdentity.update(() => "fixture-session");
    expect(getBuilderSandboxId(fixture())).toBe("simulated-fixture-session");
    expect(getBuilderSandboxId(fixture())).toBe("simulated-fixture-session");
    await expect(setBuilderSandboxNetworkPolicy(fixture(), "allow-all")).resolves.toBeUndefined();
  });
});
