import { describe, expect, it } from "vitest";

import { hostedGitHubInstallationBindingSchema } from "./postgres-github-installation-store";

describe("tenant GitHub installation binding schema", () => {
  it("accepts one exact active installation identity", () => {
    expect(
      hostedGitHubInstallationBindingSchema.parse({
        installationId: "123",
        accountId: "456",
        accountLogin: "withAutograph",
        accountType: "Organization",
        active: true,
        updatedAt: new Date("2026-08-28T00:00:00.000Z"),
      }),
    ).toMatchObject({ installationId: "123", active: true });
  });

  it("rejects extra identity fields and malformed provider ids", () => {
    expect(() =>
      hostedGitHubInstallationBindingSchema.parse({
        installationId: "0",
        accountId: "456",
        accountLogin: "withAutograph",
        accountType: "Organization",
        active: true,
        updatedAt: new Date(),
      }),
    ).toThrow();
    expect(() =>
      hostedGitHubInstallationBindingSchema.parse({
        installationId: "123",
        accountId: "456",
        accountLogin: "withAutograph",
        accountType: "Organization",
        active: true,
        updatedAt: new Date(),
        token: "forbidden",
      }),
    ).toThrow();
  });
});
