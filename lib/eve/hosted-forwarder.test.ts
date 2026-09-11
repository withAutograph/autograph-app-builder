import { describe, expect, it } from "vitest";

import { readHostedForwarderSubject } from "./hosted-forwarder";

describe("hosted Eve forwarder binding", () => {
  it("does not accept forwarded identity outside explicit hosted mode", () => {
    expect(readHostedForwarderSubject({})).toBeUndefined();
    expect(
      readHostedForwarderSubject({ EVE_HOSTED_ADAPTER: "0" })
    ).toBeUndefined();
  });

  it("binds one exact project environment without wildcards", () => {
    expect(
      readHostedForwarderSubject({
        EVE_HOSTED_ADAPTER: "1",
        EVE_HOSTED_VERCEL_ENVIRONMENT: "preview",
        EVE_HOSTED_VERCEL_PROJECT_NAME: "autograph-app-builder",
        EVE_HOSTED_VERCEL_TEAM_SLUG: "withautograph",
        VERCEL_ENV: "preview",
      })
    ).toBe(
      "owner:withautograph:project:autograph-app-builder:environment:preview"
    );
  });

  it("binds the exact Production subject only when both environments agree", () => {
    expect(
      readHostedForwarderSubject({
        EVE_HOSTED_ADAPTER: "1",
        EVE_HOSTED_VERCEL_ENVIRONMENT: "production",
        EVE_HOSTED_VERCEL_PROJECT_NAME: "autograph-app-builder",
        EVE_HOSTED_VERCEL_TEAM_SLUG: "withautograph",
        VERCEL_ENV: "production",
      })
    ).toBe(
      "owner:withautograph:project:autograph-app-builder:environment:production"
    );
  });

  it("fails closed on missing, wildcard, or unsupported bindings", () => {
    for (const environment of [
      { EVE_HOSTED_ADAPTER: "1" },
      {
        EVE_HOSTED_ADAPTER: "1",
        EVE_HOSTED_VERCEL_ENVIRONMENT: "preview",
        EVE_HOSTED_VERCEL_PROJECT_NAME: "autograph-app-builder",
        EVE_HOSTED_VERCEL_TEAM_SLUG: "*",
        VERCEL_ENV: "preview",
      },
      {
        EVE_HOSTED_ADAPTER: "1",
        EVE_HOSTED_VERCEL_ENVIRONMENT: "*",
        EVE_HOSTED_VERCEL_PROJECT_NAME: "autograph-app-builder",
        EVE_HOSTED_VERCEL_TEAM_SLUG: "withautograph",
        VERCEL_ENV: "preview",
      },
      {
        EVE_HOSTED_ADAPTER: "1",
        EVE_HOSTED_VERCEL_ENVIRONMENT: "production",
        EVE_HOSTED_VERCEL_PROJECT_NAME: "autograph-app-builder",
        EVE_HOSTED_VERCEL_TEAM_SLUG: "withautograph",
        VERCEL_ENV: "preview",
      },
      {
        EVE_HOSTED_ADAPTER: "1",
        EVE_HOSTED_VERCEL_ENVIRONMENT: "development",
        EVE_HOSTED_VERCEL_PROJECT_NAME: "autograph-app-builder",
        EVE_HOSTED_VERCEL_TEAM_SLUG: "withautograph",
        VERCEL_ENV: "development",
      },
    ]) {
      expect(() => readHostedForwarderSubject(environment)).toThrow();
    }
  });
});
