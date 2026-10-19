import { describe, expect, it } from "vitest";

import { parseProtectedResourceLockDatabaseUrl } from "./protected-resource-lock-database-url";
import { parseHostedDatabaseUrl } from "./postgres-connection-policy";

describe("protected resource lock database URL", () => {
  it("derives the direct host while preserving database, user, password and TLS options", () => {
    const pooled =
      "postgresql://lock_user:p%40ssword@ep-preview-pooler.us-east-2.aws.neon.tech/appdb?sslmode=verify-full&options=project%3Dep-preview";
    const direct = new URL(parseProtectedResourceLockDatabaseUrl(pooled));
    expect(direct.hostname).toBe("ep-preview.us-east-2.aws.neon.tech");
    expect(direct.username).toBe("lock_user");
    expect(direct.password).toBe("p%40ssword");
    expect(direct.pathname).toBe("/appdb");
    expect(direct.searchParams.get("sslmode")).toBe("verify-full");
    expect(direct.searchParams.get("options")).toBe("project=ep-preview");
    expect(parseHostedDatabaseUrl(pooled)).toBe(pooled);
  });

  it.each([
    "postgresql://localhost/app",
    "postgresql://operator:secret@postgres.internal:5432/app?sslmode=verify-full",
  ])("preserves validated non-Neon transport URLs (%s)", (value) => {
    expect(parseProtectedResourceLockDatabaseUrl(value)).toBe(value);
  });

  it.each([
    "postgresql://user:secret@ep-preview.us-east-2.aws.neon.tech/app?sslmode=require",
    "postgresql://user:secret@ep-preview-pooler.us-east-2.aws.neon.tech/app?sslmode=disable",
  ])("keeps the hosted Neon pooler and TLS requirements (%s)", (value) => {
    expect(() => parseProtectedResourceLockDatabaseUrl(value)).toThrow();
  });
});
