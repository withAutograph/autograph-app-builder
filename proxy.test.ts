import { NextRequest } from "next/server";
import { afterEach, describe, expect, it } from "vitest";

import { proxy } from "./proxy";

const originalEnvironment = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnvironment };
});

describe("Preview authentication origin proxy", () => {
  it("moves immutable Preview authentication pages to the branch origin", () => {
    process.env.APP_BUILDER_PREVIEW_PROVIDER_EMULATION = "1";
    process.env.VERCEL_ENV = "preview";
    process.env.VERCEL_BRANCH_URL = "app-git-feature-team.vercel.app";

    const response = proxy(
      new NextRequest(
        "https://app-deployment-team.vercel.app/auth/sign-in?callbackURL=%2F",
      ),
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "https://app-git-feature-team.vercel.app/auth/sign-in?callbackURL=%2F",
    );
  });

  it("does not redirect local, Production, canonical, or malformed hosts", () => {
    const request = new NextRequest("https://localhost:3001/auth/sign-in");
    expect(proxy(request).headers.get("location")).toBeNull();

    process.env.APP_BUILDER_PREVIEW_PROVIDER_EMULATION = "1";
    process.env.VERCEL_ENV = "production";
    process.env.VERCEL_BRANCH_URL = "app-git-feature-team.vercel.app";
    expect(proxy(request).headers.get("location")).toBeNull();

    process.env.VERCEL_ENV = "preview";
    expect(
      proxy(
        new NextRequest("https://app-git-feature-team.vercel.app/auth/sign-in"),
      ).headers.get("location"),
    ).toBeNull();
    expect(
      proxy(
        new NextRequest("https://attacker.example.com/auth/sign-in"),
      ).headers.get("location"),
    ).toBeNull();
  });
});
