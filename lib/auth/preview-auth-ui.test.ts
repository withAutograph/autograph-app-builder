import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import { afterEach, describe, expect, it } from "vitest";

import { resolveAuthCallbackURL } from "./preview-auth-ui";

const originalWindow = globalThis.window;

afterEach(() => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: originalWindow,
  });
});

describe("Preview Better Auth UI", () => {
  it("keeps the product callback override and defaults ordinary sign-in", () => {
    expect(resolveAuthCallbackURL("https://builder.example.test/", "")).toBe(
      "https://builder.example.test/",
    );
    expect(
      resolveAuthCallbackURL(
        "https://builder.example.test/",
        "?callbackURL=%2Fworkspace",
      ),
    ).toBe("/workspace");
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
        "?callbackURL=%2Fworkspace%3Fsource%3Doauth%23complete",
      ),
    ).toBe("/workspace?source=oauth#complete");
  });

  it("preserves absolute callbacks for the current origin", () => {
    expect(
      resolveAuthCallbackURL(
        "/",
        `?callbackURL=${encodeURIComponent("https://builder.example.test/workspace?source=oauth")}`,
        "https://builder.example.test",
      ),
    ).toBe("/workspace?source=oauth");
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
