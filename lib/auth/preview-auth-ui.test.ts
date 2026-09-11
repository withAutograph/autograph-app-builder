import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_AUTH_REDIRECT_TO,
  resolveAuthCallbackURL,
  resolvePasskeyRedirectTo,
  resolveProviderCallbackURL,
  serializeAuthPageSearchParams,
} from "./preview-auth-ui";

const originalWindow = globalThis.window;

afterEach(() => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: originalWindow,
  });
});

describe("Preview Better Auth UI", () => {
  it("serializes complete and repeated auth-page search parameters", () => {
    const search = serializeAuthPageSearchParams({
      callbackURL: [
        "/workspace?source=one#first",
        "/workspace?source=two#second",
      ],
      redirectTo: "/auth/setting-up?callbackURL=%2Ffinal%3Fsource%3Dnested",
      passkey: "unavailable",
      omitted: undefined,
    });
    const parsed = new URLSearchParams(search);

    expect(parsed.getAll("callbackURL")).toEqual([
      "/workspace?source=one#first",
      "/workspace?source=two#second",
    ]);
    expect(parsed.get("redirectTo")).toBe(
      "/auth/setting-up?callbackURL=%2Ffinal%3Fsource%3Dnested",
    );
    expect(parsed.get("passkey")).toBe("unavailable");
    expect(parsed.has("omitted")).toBe(false);
  });

  it("resolves a serialized Sign Up callback through the shared setup route", () => {
    const search = serializeAuthPageSearchParams({
      callbackURL: "/workspace?source=signed-in#complete",
    });

    expect(
      resolvePasskeyRedirectTo(
        DEFAULT_AUTH_REDIRECT_TO,
        search,
        "https://builder.example.test",
      ),
    ).toBe(
      "/auth/setting-up?callbackURL=%2Fworkspace%3Fsource%3Dsigned-in%23complete",
    );
  });

  it("uses the first repeated redirect and rejects it when it is external", () => {
    const safeRedirect =
      "/auth/setting-up?callbackURL=%2Fworkspace%3Fsource%3Dfirst";
    const externalRedirect = "https://external.example/steal";

    expect(
      resolvePasskeyRedirectTo(
        DEFAULT_AUTH_REDIRECT_TO,
        serializeAuthPageSearchParams({
          redirectTo: [safeRedirect, externalRedirect],
        }),
        "https://builder.example.test",
      ),
    ).toBe(safeRedirect);
    expect(
      resolvePasskeyRedirectTo(
        DEFAULT_AUTH_REDIRECT_TO,
        serializeAuthPageSearchParams({
          redirectTo: [externalRedirect, safeRedirect],
        }),
        "https://builder.example.test",
      ),
    ).toBe(DEFAULT_AUTH_REDIRECT_TO);
  });

  it("keeps the product callback override and defaults ordinary sign-in", () => {
    expect(resolveAuthCallbackURL("https://builder.example.test/", "")).toBe(
      "https://builder.example.test/",
    );
    expect(
      resolveAuthCallbackURL(
        "https://builder.example.test/",
        "?callbackURL=%2F",
      ),
    ).toBe("/");
  });

  it.each([
    "https://external.example/steal",
    "//external.example/steal",
    "not a valid callback",
  ])("rejects unsafe callback %s", (callbackURL) => {
    expect(
      resolveAuthCallbackURL(
        "/",
        `?callbackURL=${encodeURIComponent(callbackURL)}`,
      ),
    ).toBe("/");
  });

  it("preserves callback query strings and fragments", () => {
    expect(
      resolveAuthCallbackURL(
        "/",
        "?callbackURL=%2F%3Fsource%3Doauth%23complete",
      ),
    ).toBe("/?source=oauth#complete");
  });

  it("preserves absolute callbacks for the current origin", () => {
    expect(
      resolveAuthCallbackURL(
        "/",
        `?callbackURL=${encodeURIComponent("https://builder.example.test/?source=oauth")}`,
        "https://builder.example.test",
      ),
    ).toBe("/?source=oauth");
  });

  it("builds the provider callback from the site origin", () => {
    expect(
      resolveProviderCallbackURL(
        "/auth/setting-up?callbackURL=%2F",
        "/?source=oauth",
        "https://builder.example.test",
      ).toString(),
    ).toBe(
      "https://builder.example.test/auth/setting-up?callbackURL=%2F%3Fsource%3Doauth",
    );
  });

  it("builds the passkey redirect from a safe callback override", () => {
    expect(
      resolvePasskeyRedirectTo(
        "/auth/setting-up?callbackURL=%2F",
        "?callbackURL=%2Fworkspace%3Fsource%3Dbrief%23complete",
        "https://builder.example.test",
      ),
    ).toBe(
      "/auth/setting-up?callbackURL=%2Fworkspace%3Fsource%3Dbrief%23complete",
    );
  });

  it("preserves an inherited redirect when no callback override is present", () => {
    expect(
      resolvePasskeyRedirectTo(
        "/auth/setting-up?callbackURL=%2Fworkspace%3Fsource%3Dbrief",
        "?redirectTo=%2Fauth%2Fsetting-up%3FcallbackURL%3D%252Fworkspace%253Fsource%253Dbrief",
        "https://builder.example.test",
      ),
    ).toBe("/auth/setting-up?callbackURL=%2Fworkspace%3Fsource%3Dbrief");
  });

  it("rejects an inherited cross-origin passkey redirect", () => {
    expect(
      resolvePasskeyRedirectTo(
        "/auth/setting-up?callbackURL=%2F",
        "?redirectTo=https%3A%2F%2Fexternal.example%2Fsteal",
        "https://builder.example.test",
      ),
    ).toBe("/auth/setting-up?callbackURL=%2F");
  });

  it("forwards the complete signed OAuth query through social sign-in", async () => {
    const search =
      "?client_id=one&scope=autograph%3Aget&state=opaque&sig=signed" +
      "&ba_param=client_id&ba_param=scope&ba_param=state&ba_param=sig" +
      "&ba_param=ba_param";
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { location: { search } },
    });
    const request = {
      method: "POST",
      headers: new Headers({ "content-type": "application/json" }),
      body: JSON.stringify({ provider: "github", callbackURL: "/" }),
    };
    const clientPlugin = oauthProviderClient();
    const onRequest = clientPlugin.fetchPlugins?.[0]?.hooks?.onRequest;

    expect(onRequest).toBeTypeOf("function");
    await onRequest?.(request as never);

    const body = JSON.parse(request.body) as Record<string, string>;
    expect(new URLSearchParams(body.oauth_query).getAll("ba_param")).toEqual([
      "client_id",
      "scope",
      "state",
      "sig",
      "ba_param",
    ]);
    expect(body.oauth_query).toContain("client_id=one");
    expect(body.oauth_query).toContain("scope=autograph%3Aget");
    expect(body.oauth_query).toContain("state=opaque");
    expect(body.oauth_query).toContain("sig=signed");
  });
});
