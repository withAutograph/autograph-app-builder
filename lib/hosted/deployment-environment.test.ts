import { describe, expect, it } from "vitest";

import { readHostedDeploymentEnvironment } from "./deployment-environment";

describe("hosted deployment environment binding", () => {
  it.each(["preview", "production"] as const)(
    "accepts only an exact %s agreement",
    (deploymentEnvironment) => {
      expect(
        readHostedDeploymentEnvironment({
          EVE_HOSTED_ADAPTER: "1",
          VERCEL_ENV: deploymentEnvironment,
          EVE_HOSTED_VERCEL_ENVIRONMENT: deploymentEnvironment,
        }),
      ).toBe(deploymentEnvironment);
    },
  );

  it("fails closed when either binding is absent, unsupported, or mismatched", () => {
    for (const environment of [
      {},
      { EVE_HOSTED_ADAPTER: "0" },
      {
        EVE_HOSTED_ADAPTER: "1",
        VERCEL_ENV: "preview",
      },
      {
        EVE_HOSTED_ADAPTER: "1",
        VERCEL_ENV: "preview",
        EVE_HOSTED_VERCEL_ENVIRONMENT: "production",
      },
      {
        EVE_HOSTED_ADAPTER: "1",
        VERCEL_ENV: "production",
        EVE_HOSTED_VERCEL_ENVIRONMENT: "preview",
      },
      {
        EVE_HOSTED_ADAPTER: "1",
        VERCEL_ENV: "development",
        EVE_HOSTED_VERCEL_ENVIRONMENT: "development",
      },
    ]) {
      expect(() => readHostedDeploymentEnvironment(environment)).toThrow(
        "exact matching Preview or Production",
      );
    }
  });
});
