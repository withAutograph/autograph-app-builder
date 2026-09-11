import { describe, expect, it } from "vitest";

import { TEST_CAPABILITIES, testCapabilityEnabled } from "./test-capability";

const id = "a".repeat(64);
const injected = Object.freeze({
  version: 1 as const,
  id,
  capabilities: Object.freeze([...TEST_CAPABILITIES]),
});

describe("testCapabilityEnabled", () => {
  it("rejects environment flags without structural injection", () => {
    for (const capability of TEST_CAPABILITIES)
      expect(
        testCapabilityEnabled(
          capability,
          {
            APP_BUILDER_TEST_MODEL: "1",
            APP_BUILDER_TEST_CAPABILITY_ID: id,
          },
          undefined,
        ),
      ).toBe(false);
  });

  it("requires the exact task-owned nonce and a closed V1 capability", () => {
    const environment = {
      APP_BUILDER_TEST_MODEL: "1",
      APP_BUILDER_TEST_CAPABILITY_ID: id,
    };
    expect(
      testCapabilityEnabled("simulated-target", environment, injected),
    ).toBe(true);
    expect(
      testCapabilityEnabled(
        "simulated-target",
        environment,
        Object.freeze({ ...injected, id: "b".repeat(64) }),
      ),
    ).toBe(false);
    expect(
      testCapabilityEnabled(
        "simulated-target",
        environment,
        Object.freeze({ ...injected, version: 2 }),
      ),
    ).toBe(false);
    expect(
      testCapabilityEnabled(
        "simulated-target",
        environment,
        Object.freeze({
          ...injected,
          capabilities: Object.freeze([...TEST_CAPABILITIES, "unknown"]),
        }),
      ),
    ).toBe(false);
    expect(
      testCapabilityEnabled(
        "simulated-target",
        environment,
        Object.freeze({ ...injected, extra: true }),
      ),
    ).toBe(false);
  });

  it("keeps real sandbox proof free of target and publication simulation", () => {
    const environment = {
      APP_BUILDER_TEST_MODEL: "1",
      APP_BUILDER_TEST_CAPABILITY_ID: id,
      APP_BUILDER_REAL_SANDBOX: "1",
    };
    expect(testCapabilityEnabled("mock-model", environment, injected)).toBe(
      true,
    );
    expect(
      testCapabilityEnabled("simulated-target", environment, injected),
    ).toBe(false);
    expect(
      testCapabilityEnabled("simulated-publication", environment, injected),
    ).toBe(false);
  });

  it("does not enable the mock model without its explicit request flag", () => {
    expect(
      testCapabilityEnabled(
        "mock-model",
        { APP_BUILDER_TEST_CAPABILITY_ID: id },
        injected,
      ),
    ).toBe(false);
  });
});
