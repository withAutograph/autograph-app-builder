import { createAccessProof } from "flags";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

import { builderConnectionsFlag, selfServiceSignupFlag } from "../../../../lib/feature-flags";
import type { getProviderData as getProviderDataType } from "@flags-sdk/vercel";

const getProviderData = vi.hoisted(() => vi.fn());

vi.mock("@flags-sdk/vercel", async (importOriginal) => ({
  ...(await importOriginal<{ getProviderData: typeof getProviderDataType }>()),
  getProviderData,
}));

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
      new NextRequest("https://agent.example.com/.well-known/vercel/flags"),
    );

    expect(response.status).toBe(401);
    expect(getProviderData).not.toHaveBeenCalled();
  });

  it("returns the declared flags to an authenticated Vercel request", async () => {
    const secret = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE";
    vi.stubEnv("FLAGS_SECRET", secret);
    const proof = await createAccessProof(secret);

    const response = await GET(
      new NextRequest("https://agent.example.com/.well-known/vercel/flags", {
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
