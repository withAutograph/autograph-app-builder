import { describe, expect, it } from "vitest";

import {
  builderConnectionsFlag,
  selfServiceSignupFlag,
} from "./feature-flags";

describe("Vercel feature flags", () => {
  it("declares the supported Boolean flags with fail-closed defaults", () => {
    expect(builderConnectionsFlag.key).toBe("builder-connections");
    expect(builderConnectionsFlag.defaultValue).toBe(false);
    expect(builderConnectionsFlag.options).toEqual([
      { value: false, label: "Disabled" },
      { value: true, label: "Enabled" },
    ]);
    expect(selfServiceSignupFlag.key).toBe("self-service-signup");
    expect(selfServiceSignupFlag.defaultValue).toBe(false);
    expect(selfServiceSignupFlag.options).toEqual([
      { value: false, label: "Disabled" },
      { value: true, label: "Enabled" },
    ]);
  });
});
