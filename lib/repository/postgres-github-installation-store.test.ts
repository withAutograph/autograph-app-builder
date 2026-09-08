import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  hostedGitHubInstallationBindingSchema,
  mergeHostedGitHubInstallationBindings,
} from "./postgres-github-installation-store";

describe("tenant GitHub installation binding schema", () => {
  it("scopes a repeated installation to its tenant while retaining same-tenant idempotency", async () => {
    const migration = await readFile(
      "drizzle/0014_tenant_github_installation_uniqueness.sql",
      "utf8",
    );

    expect(migration).toContain(
      'DROP INDEX IF EXISTS "hosted_github_installation_binding_id_uidx";',
    );
    expect(migration).toContain(
      'ON "hosted_github_installation_binding" ("installation_id", "issuer", "audience", "workspace_id", "owner_user_id");',
    );
    expect(migration).not.toContain(
      'ON "hosted_github_installation_binding" ("installation_id");',
    );
  });

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

  it("keeps a legacy scope visible beside new multi-installation bindings", () => {
    const updatedAt = new Date("2026-08-28T00:00:00.000Z");
    const legacy = hostedGitHubInstallationBindingSchema.parse({
      installationId: "123",
      accountId: "456",
      accountLogin: "withAutograph",
      accountType: "Organization",
      active: true,
      updatedAt,
    });
    const added = hostedGitHubInstallationBindingSchema.parse({
      installationId: "789",
      accountId: "987",
      accountLogin: "autograph-labs",
      accountType: "Organization",
      active: true,
      updatedAt,
    });

    expect(mergeHostedGitHubInstallationBindings([added], legacy)).toEqual([
      added,
      legacy,
    ]);
    expect(mergeHostedGitHubInstallationBindings([legacy], legacy)).toEqual([
      legacy,
    ]);
  });
});
