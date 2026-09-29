import { ClientError } from "eve/client";
import { describe, expect, it } from "vitest";

import { isUnavailableLocalSession } from "./local-session-recovery";

describe("installed Eve local session availability", () => {
  it("distinguishes transient inbox startup from an inactive original session", () => {
    expect(
      isUnavailableLocalSession(
        new ClientError(409, JSON.stringify({ code: "session_not_ready" })),
      ),
    ).toBe(false);
    expect(
      isUnavailableLocalSession(
        new ClientError(409, JSON.stringify({ code: "session_not_active" })),
      ),
    ).toBe(true);
    expect(isUnavailableLocalSession(new ClientError(404, "Missing"))).toBe(true);
    expect(isUnavailableLocalSession(new ClientError(500, "Unavailable"))).toBe(false);
  });
});
