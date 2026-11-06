import { describe, expect, it } from "vitest";

import { renewBuilderHandoff } from "./handoff-renewal";

const id = "123e4567-e89b-42d3-a456-426614174001";

describe("renewBuilderHandoff", () => {
  it("rejects malformed client input before accessing request context", async () => {
    await expect(
      renewBuilderHandoff(undefined, {
        creationRequestId: "123e4567-e89b-42d3-a456-426614174003",
        handoffId: "not-a-uuid",
      }),
    ).resolves.toEqual({ status: "error" });

    await expect(
      renewBuilderHandoff(undefined, {
        creationRequestId: id,
        handoffId: id,
      }),
    ).resolves.toEqual({ status: "error" });
  });
});
