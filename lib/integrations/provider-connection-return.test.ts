import { describe, expect, it } from "vitest";

import {
  parseProviderConnectionReturn,
  providerConnectionRedirect,
  providerConnectionReturnFromFormData,
  safeProviderConnectionReturn,
} from "./provider-connection-return";

const handoff = "/handoff/1c7ed773-0aa9-4e32-9e65-6eb36e7b5cc0";
const resumeKey = "ed5bc83d-a08f-42be-9635-4677fa7bdb32";
describe("provider return routing", () => {
  it("retains handoff and existing session continuation through form and callback", () => {
    const form = new FormData();
    form.set("returnTo", handoff);
    form.set("resumeKey", resumeKey);
    const state = providerConnectionReturnFromFormData(form);
    expect(state).toEqual({ resumeKey, returnTo: handoff });
    for (const provider of ["github", "vercel"] as const) {
      const url = new URL(
        providerConnectionRedirect({
          origin: "https://builder.example",
          provider,
          returnState: state,
          status: "connected",
        })
      );
      expect(url.origin).toBe("https://builder.example");
      expect(url.pathname).toBe(handoff);
      expect(url.searchParams.get("resume")).toBe(resumeKey);
      expect(url.searchParams.get(provider)).toBe("connected");
    }
  });
  it.each([
    "https://evil.example",
    "//evil.example",
    "/other",
    `${handoff}/..`,
    `${handoff}?next=https://evil.example`,
    `${handoff}#secret`,
    "/handoff/not-a-uuid",
    "/handoff/%2e%2e",
    `/\\evil.example`,
    `${handoff}/extra`,
  ])("rejects unsafe return %s", (returnTo) => {
    expect(() => parseProviderConnectionReturn({ returnTo })).toThrow();
    expect(safeProviderConnectionReturn({ returnTo })).toEqual({
      returnTo: "/",
    });
  });
  it("keeps legacy root and failed callbacks compatible", () => {
    expect(parseProviderConnectionReturn({})).toEqual({ returnTo: "/" });
    expect(
      providerConnectionRedirect({
        origin: "https://builder.example",
        provider: "vercel",
        reason: "callback-invalid",
        returnState: { returnTo: handoff },
        status: "failed",
      })
    ).toBe(
      `https://builder.example${handoff}?vercel=failed&vercelReason=callback-invalid`
    );
  });
});
