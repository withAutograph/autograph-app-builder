import { describe, expect, it, vi } from "vitest";

import {
  createHostedVercelBackend,
  type HostedVercelBackendFactory,
  type HostedVercelBackendOptions,
} from "./vercel-backend";

describe("hosted Vercel sandbox backend", () => {
  it("allows bootstrap hosts only for prewarm and denies every fresh live session", async () => {
    let options: HostedVercelBackendOptions | undefined;
    const factory = vi.fn(((input: HostedVercelBackendOptions) => {
      options = input;
      return { name: "injected-vercel-backend" } as never;
    }) satisfies HostedVercelBackendFactory);

    createHostedVercelBackend(factory);

    expect(factory).toHaveBeenCalledOnce();
    expect(options).toBeDefined();
    expect(options!.networkPolicy).toEqual({
      allow: ["github.com", "release-assets.githubusercontent.com"],
    });

    const initialSession = options!.sessionCreateOptions();
    const providerLossReplacement = options!.sessionCreateOptions();
    expect(initialSession).toEqual({ networkPolicy: "deny-all" });
    expect(providerLossReplacement).toEqual({ networkPolicy: "deny-all" });
  });
});
