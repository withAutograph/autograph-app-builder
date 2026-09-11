import { describe, expect, it } from "vitest";

import { executionDependencyLayoutSchema } from "../repository/dependency-cache";

describe("planning dependency setup", () => {
  it("uses the writable checkout instead of requiring a prebuilt dependency cache", () => {
    expect(
      executionDependencyLayoutSchema.parse({
        kind: "checkout",
        roots: [],
        version: 1,
        workspaceLinks: [],
      })
    ).toEqual({
      kind: "checkout",
      roots: [],
      version: 1,
      workspaceLinks: [],
    });
  });
});
