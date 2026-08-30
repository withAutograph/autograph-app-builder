import { describe, expect, it } from "vitest";
import { readLocalProviderEmulation } from "./local-provider-emulation";

const environment = {
  APP_BUILDER_LOCAL_PROVIDER_EMULATION: "1",
  NODE_ENV: "development",
  VERCEL_EMULATOR_URL: "http://localhost:4000",
  GITHUB_EMULATOR_URL: "https://github.emulate.localhost",
  EMULATE_PROVIDER_TOKEN: "x".repeat(20),
  EMULATE_GITHUB_REPOSITORY: "autograph-local/demo-app",
  EMULATE_LOCAL_RELAY_SECRET: "s".repeat(32),
};

describe("local provider emulation", () => {
  it("accepts only explicit local development origins", () => {
    expect(readLocalProviderEmulation(environment)).toMatchObject({
      vercelOrigin: "http://localhost:4000",
    });
    expect(() =>
      readLocalProviderEmulation({ ...environment, VERCEL_ENV: "preview" }),
    ).toThrow();
    expect(() =>
      readLocalProviderEmulation({
        ...environment,
        GITHUB_EMULATOR_URL: "https://api.github.com",
      }),
    ).toThrow();
  });
});
