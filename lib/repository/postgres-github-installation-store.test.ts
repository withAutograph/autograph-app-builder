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
      "utf-8"
    );

    expect(migration).toContain(
      'DROP INDEX IF EXISTS "hosted_github_installation_binding_id_uidx";'
    );
    expect(migration).toContain(
      'ON "hosted_github_installation_binding" ("installation_id", "issuer", "audience", "workspace_id", "owner_user_id");'
    );
    expect(migration).not.toContain(
      'ON "hosted_github_installation_binding" ("installation_id");'
    );
  });

  it("accepts one exact active installation identity", () => {
    expect(
      hostedGitHubInstallationBindingSchema.parse({
        accountId: "456",
        accountLogin: "withAutograph",
        accountType: "Organization",
        active: true,
        installationId: "123",
        updatedAt: new Date("2026-08-28T00:00:00.000Z"),
      })
    ).toMatchObject({ active: true, installationId: "123" });
  });

  it("rejects extra identity fields and malformed provider ids", () => {
    expect(() =>
      hostedGitHubInstallationBindingSchema.parse({
        accountId: "456",
        accountLogin: "withAutograph",
        accountType: "Organization",
        active: true,
        installationId: "0",
        updatedAt: new Date(),
      })
    ).toThrow();
    expect(() =>
      hostedGitHubInstallationBindingSchema.parse({
        accountId: "456",
        accountLogin: "withAutograph",
        accountType: "Organization",
        active: true,
        installationId: "123",
        token: "forbidden",
        updatedAt: new Date(),
      })
    ).toThrow();
  });

  it("keeps a legacy scope visible beside new multi-installation bindings", () => {
    const updatedAt = new Date("2026-08-28T00:00:00.000Z");
    const legacy = hostedGitHubInstallationBindingSchema.parse({
      accountId: "456",
      accountLogin: "withAutograph",
      accountType: "Organization",
      active: true,
      installationId: "123",
      updatedAt,
    });
    const added = hostedGitHubInstallationBindingSchema.parse({
      accountId: "987",
      accountLogin: "autograph-labs",
      accountType: "Organization",
      active: true,
      installationId: "789",
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
