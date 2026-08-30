import { describe, expect, it } from "vitest";

import { passkeyClientError } from "./passkey-client-result";

describe("passkeyClientError", () => {
  it("accepts successful Better Auth passkey responses", () => {
    expect(
      passkeyClientError({ data: { session: {} }, error: null }),
    ).toBeNull();
  });

  it("turns resolved WebAuthn cancellation responses into errors", () => {
    const error = passkeyClientError({
      data: null,
      error: {
        code: "AUTH_CANCELLED",
        message: "Passkey authentication was cancelled.",
      },
    });

    expect(error).toMatchObject({
      name: "AUTH_CANCELLED",
      message: "Passkey authentication was cancelled.",
    });
  });

  it("does the same for a cancelled registration ceremony", () => {
    expect(
      passkeyClientError({
        data: null,
        error: { code: "ERROR_CEREMONY_ABORTED", message: "Cancelled." },
      }),
    ).toMatchObject({ name: "ERROR_CEREMONY_ABORTED", message: "Cancelled." });
  });
});
