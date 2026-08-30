import { createAccessProof } from "flags";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  builderConnectionsFlag,
  selfServiceSignupFlag,
} from "../../../../lib/feature-flags";

const getProviderData = vi.hoisted(() => vi.fn());

vi.mock("@flags-sdk/vercel", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@flags-sdk/vercel")>()),
  getProviderData,
}));

import { GET } from "./route";

describe("Vercel Flags discovery route", () => {
  beforeEach(() => {
    getProviderData.mockResolvedValue({
      definitions: {
        "builder-connections": { defaultValue: false },
        "self-service-signup": { defaultValue: false },
      },
      hints: [],
    });
  });

  it("rejects unauthenticated discovery requests", async () => {
    const response = await GET(
      new Request("https://agent.example.com/.well-known/vercel/flags"),
    );

    expect(response.status).toBe(401);
    expect(getProviderData).not.toHaveBeenCalled();
  });

  it("returns the declared flags to an authenticated Vercel request", async () => {
    const secret = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE";
    vi.stubEnv("FLAGS_SECRET", secret);
    const proof = await createAccessProof(secret);

    const response = await GET(
      new Request("https://agent.example.com/.well-known/vercel/flags", {
        headers: { Authorization: `Bearer ${proof}` },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      definitions: {
        "builder-connections": { defaultValue: false },
        "self-service-signup": { defaultValue: false },
      },
      hints: [],
    });
    expect(getProviderData).toHaveBeenCalledWith(
      expect.objectContaining({
        builderConnectionsFlag,
        selfServiceSignupFlag,
      }),
    );
  });
});
