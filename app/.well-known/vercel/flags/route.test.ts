import { createAccessProof } from "flags";
import { createFlagsDiscoveryEndpoint } from "flags/next";
import { describe, expect, it, vi } from "vitest";

import { builderConnectionsFlag, selfServiceSignupFlag } from "../../../../lib/feature-flags";

const providerData = {
  definitions: {
    "builder-connections": { defaultValue: false },
    "self-service-signup": { defaultValue: false },
  },
  hints: [],
};

const getProviderData = (_flags: {
  builderConnectionsFlag: typeof builderConnectionsFlag;
  selfServiceSignupFlag: typeof selfServiceSignupFlag;
}) => providerData;

describe("Vercel Flags discovery route", () => {
  it("rejects unauthenticated discovery requests", async () => {
    const get = createFlagsDiscoveryEndpoint(() => providerData);
    const response = await get(new Request("https://agent.example.com/.well-known/vercel/flags"));

    expect(response.status).toBe(401);
  });

  it("returns the declared flags to an authenticated Vercel request", async () => {
    const secret = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE";
    vi.stubEnv("FLAGS_SECRET", secret);
    const proof = await createAccessProof(secret);
    const get = createFlagsDiscoveryEndpoint(() =>
      getProviderData({ builderConnectionsFlag, selfServiceSignupFlag }),
    );

    const response = await get(
      new Request("https://agent.example.com/.well-known/vercel/flags", {
        headers: { Authorization: `Bearer ${proof}` },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(providerData);
  });
});
