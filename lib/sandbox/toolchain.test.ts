import { describe, expect, it } from "vitest";

import {
  configuredToolchainImage,
  sandboxRevalidationKey,
  toolVersionMatches,
} from "./toolchain";

const image =
  "registry.example/autograph/app-builder-sandbox@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

describe("sandbox toolchain contract", () => {
  it("accepts only an immutable OCI digest", () => {
    expect(configuredToolchainImage({})).toBeUndefined();
    expect(configuredToolchainImage({ APP_BUILDER_SANDBOX_IMAGE: image })).toBe(
      image,
    );
    expect(() =>
      configuredToolchainImage({
        APP_BUILDER_SANDBOX_IMAGE:
          "registry.example/autograph/app-builder:latest",
      }),
    ).toThrow("must be an OCI image reference pinned");
    expect(
      configuredToolchainImage({
        APP_BUILDER_SANDBOX_IMAGE: image,
        VERCEL: "1",
        VERCEL_ENV: "preview",
      }),
    ).toBeUndefined();
  });

  it("requires the pinned mise and Bun versions", () => {
    expect(toolVersionMatches("git", "git version 2.50.1")).toBe(true);
    expect(toolVersionMatches("mise", "2026.8.12 macos-arm64")).toBe(true);
    expect(toolVersionMatches("bun", "1.3.14")).toBe(true);
    expect(toolVersionMatches("mise", "2026.8.13")).toBe(false);
    expect(toolVersionMatches("bun", "1.3.15")).toBe(false);
  });

  it("changes the template key when the configured immutable image changes", () => {
    expect(sandboxRevalidationKey(undefined)).toBe(
      "autograph-app-builder-toolchain-v2:local:unconfigured",
    );
    expect(sandboxRevalidationKey(image)).toContain(image);
  });
});
