/* oxlint-disable anti-slop/no-module-mocking -- Keep the real durable workflow and simulate time and protected setup reads. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import prepareAppProduction from "../../agent/tools/prepare-app-production";
// oxlint-disable-next-line sonarjs/no-wildcard-import -- The partial mock retains the Workflow SDK approval and continuation exports.
import type * as productionSetupSteps from "./prepare-app-production-step";

const mocks = vi.hoisted(() => ({ prepare: vi.fn(), read: vi.fn(), sleep: vi.fn() }));
vi.mock("workflow", () => ({ sleep: mocks.sleep }));
vi.mock("./prepare-app-production-step", async (original) => ({
  ...(await original<typeof productionSetupSteps>()),
  prepareAppProductionStep: mocks.prepare,
  readProductionIdentitySetupStep: mocks.read,
}));

const operationRef = "11111111-1111-4111-8111-111111111111";
const expiresAt = "2026-11-18T00:00:00Z";
const wait = { appId: "app", grantDigest: "a".repeat(64), operationRef, expiresAt };
const pending = {
  setup: {
    operationRef,
    state: "identity-required",
    signInUrl: "https://apps.example.com/sign-in",
    expiresAt,
  },
};
const ready = { operationRef, state: "ready" };

const startRelease = () => {
  // SAFETY: Both workflow boundaries are controlled ports. They don't use the test arguments.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Only the mocked boundaries inspect these fixture arguments.
  const release = prepareAppProduction.execute({} as never, {} as never);
  if (!(Symbol.asyncIterator in release)) {
    throw new Error("The setup workflow must stream its pending identity link.");
  }
  return release[Symbol.asyncIterator]();
};

describe("direct Production creator sign-in", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-11T00:00:00Z"));
    // oxlint-disable-next-line eslint/require-await -- The test clock replaces the durable sleep.
    mocks.sleep.mockReset().mockImplementation(async (time: Date) => {
      vi.setSystemTime(time);
    });
    mocks.prepare.mockReset();
    mocks.read.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it("presents the link while waiting, then continues delivery after that setup becomes ready", async () => {
    mocks.prepare.mockResolvedValue({ result: pending, identityWait: wait });
    mocks.read.mockResolvedValueOnce(pending.setup).mockResolvedValueOnce(ready);
    const release = startRelease();
    expect(await release.next()).toEqual({ done: false, value: pending });
    expect(mocks.read).not.toHaveBeenCalled();
    expect(await release.next()).toEqual({
      done: true,
      value: { setup: ready, nextCall: { tool: "read_github_pr_delivery", input: {} } },
    });
    expect(mocks.read).toHaveBeenCalledTimes(2);
    expect(mocks.read).toHaveBeenNthCalledWith(1, wait, {});
    expect(mocks.read).toHaveBeenNthCalledWith(2, wait, {});
  });

  it("keeps a pending link available after a short wait without polling until its expiry", async () => {
    mocks.prepare.mockResolvedValue({ result: pending, identityWait: wait });
    mocks.read.mockResolvedValue(pending.setup);
    const release = startRelease();
    await release.next();
    expect(await release.next()).toEqual({ done: true, value: pending });
    expect(mocks.read).toHaveBeenCalledTimes(10);
  });
});
