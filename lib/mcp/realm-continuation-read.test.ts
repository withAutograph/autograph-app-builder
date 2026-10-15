import { describe, expect, it, vi } from "vitest";
import type { ResumeRealmContinuation } from "./realm-continuation-read";
import { createRealmContinuationRead } from "./realm-continuation-read";

const read = {
  principal: {
    audience: "https://builder.example.test/mcp",
    issuer: "https://builder.example.test/api/auth",
    ownerUserId: "owner",
    scopes: ["autograph:get"],
    workspaceId: "workspace",
  },
  sessionId: "ses_public",
  adapterSessionId: "native_current",
  sourceHandoffId: "d46aad10-99a1-41c1-a496-ec452643c066",
};

describe("owned read Realm continuation", () => {
  it("passes the actual owner, scopes and both saved session identities unchanged", async () => {
    const resume = vi.fn<ResumeRealmContinuation>().mockImplementation(() => Promise.resolve());
    const environment = { EVE_HOSTED_ADAPTER: "1" };
    await createRealmContinuationRead({ environment, resume })(read);
    expect(resume).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledWith({ ...read, environment });
    expect(resume.mock.calls[0]?.[0].principal).toBe(read.principal);
  });

  it("keeps the build readable when durable recovery needs reconciliation", async () => {
    const resume = vi
      .fn<ResumeRealmContinuation>()
      .mockRejectedValue(new Error("dispatch outcome unknown"));
    await expect(
      createRealmContinuationRead({ environment: {}, resume })(read),
    ).resolves.toBeUndefined();
    expect(resume).toHaveBeenCalledTimes(1);
  });
});
