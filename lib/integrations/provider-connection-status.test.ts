import { describe, expect, it } from "vitest";

import {
  parseProviderConnectionFailureReason,
  providerConnectionFailureMessage,
} from "./provider-connection-status";

describe("provider connection status", () => {
  it("accepts only allowlisted failure reasons", () => {
    expect(parseProviderConnectionFailureReason("workspace-unavailable")).toBe(
      "workspace-unavailable",
    );
    expect(parseProviderConnectionFailureReason("secret=do-not-render")).toBe(
      undefined,
    );
    expect(parseProviderConnectionFailureReason(["request-invalid"])).toBe(
      undefined,
    );
  });

  it("renders actionable provider copy without reflecting arbitrary input", () => {
    expect(
      providerConnectionFailureMessage("Vercel", "configuration-unavailable"),
    ).toContain("administrator needs to finish provider setup");
    expect(
      providerConnectionFailureMessage("GitHub", "workspace-unavailable"),
    ).toContain("active App Builder workspace");
  });
});
