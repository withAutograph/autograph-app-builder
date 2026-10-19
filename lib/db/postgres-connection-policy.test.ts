import { describe, expect, it } from "vitest";

import {
  hostedRuntimePostgresOptions,
  hostedTaskPostgresOptions,
  parseHostedDatabaseUrl,
  parseMigrationDatabaseUrl,
} from "./postgres-connection-policy";

describe("hosted PostgreSQL connection policy", () => {
  it("keeps runtime and task pools bounded with finite lifetimes", () => {
    expect(hostedRuntimePostgresOptions).toMatchObject({
      connect_timeout: 5,
      connection: {
        idle_in_transaction_session_timeout: 30_000,
        lock_timeout: 5000,
        statement_timeout: 30_000,
      },
      idle_timeout: 20,
      max: 5,
      max_lifetime: 300,
      prepare: false,
    });
    expect(hostedTaskPostgresOptions).toMatchObject({
      connect_timeout: 5,
      connection: {
        idle_in_transaction_session_timeout: 15_000,
        lock_timeout: 5000,
        statement_timeout: 15_000,
      },
      idle_timeout: 5,
      max: 1,
      max_lifetime: 60,
      prepare: false,
    });
  });

  it("requires a TLS pooled endpoint for Neon without restricting local PostgreSQL", () => {
    expect(
      parseHostedDatabaseUrl(
        "postgresql://user:secret@ep-preview-pooler.us-east-2.aws.neon.tech/app?sslmode=require",
      ),
    ).toContain("ep-preview-pooler");
    expect(parseHostedDatabaseUrl("postgresql://localhost/app")).toBe("postgresql://localhost/app");
    expect(() =>
      parseHostedDatabaseUrl(
        "postgresql://user:secret@ep-preview.us-east-2.aws.neon.tech/app?sslmode=require",
      ),
    ).toThrow("pooled endpoint");
    expect(() =>
      parseHostedDatabaseUrl(
        "postgresql://user:secret@ep-preview-pooler.us-east-2.aws.neon.tech/app?sslmode=disable",
      ),
    ).toThrow("requires TLS");
  });

  it("rejects malformed, non-PostgreSQL, and secret-frame-breaking values", () => {
    for (const value of ["not-a-url", "mysql://localhost/app", "postgresql://localhost/app\n"]) {
      expect(() => parseHostedDatabaseUrl(value)).toThrow();
    }
  });

  it.each(["require", "verify-full"])(
    "accepts a direct Neon migration connection with %s TLS without changing its bytes",
    (sslmode) => {
      const direct = `postgresql://migration_owner:synthetic%40secret@ep-preview.us-east-2.aws.neon.tech/app?sslmode=${sslmode}&channel_binding=require`;
      expect(parseMigrationDatabaseUrl(direct)).toBe(direct);
      expect(() => parseHostedDatabaseUrl(direct)).toThrow("pooled endpoint");
    },
  );

  it("keeps pooled Neon endpoints exclusive to the hosted runtime reader", () => {
    const pooled =
      "postgresql://user:synthetic@ep-preview-pooler.us-east-2.aws.neon.tech/app?sslmode=require";
    expect(() => parseMigrationDatabaseUrl(pooled)).toThrow("direct endpoint");
    expect(parseHostedDatabaseUrl(pooled)).toBe(pooled);
    expect(parseMigrationDatabaseUrl("postgresql://localhost/app")).toBe(
      "postgresql://localhost/app",
    );
  });

  it.each([
    "not-a-url",
    "mysql://localhost/app",
    "postgresql://localhost/app\n",
    "postgresql://localhost/app\r",
    "postgresql://localhost/app\0",
    "postgresql://user:synthetic@ep-preview.us-east-2.aws.neon.tech/app",
    "postgresql://user:synthetic@ep-preview.us-east-2.aws.neon.tech/app?sslmode=disable",
    "postgresql://user:synthetic@ep-preview.us-east-2.aws.neon.tech/app?sslmode=prefer",
    "x".repeat(8193),
  ])("retains migration protocol, TLS, and bounded secret validation (%#)", (value) => {
    expect(() => parseMigrationDatabaseUrl(value)).toThrow();
  });
});
