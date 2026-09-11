import { describe, expect, it } from "vitest";

import {
  hostedRuntimePostgresOptions,
  hostedTaskPostgresOptions,
  parseHostedDatabaseUrl,
} from "./postgres-connection-policy";

describe("hosted PostgreSQL connection policy", () => {
  it("keeps runtime and task pools bounded with finite lifetimes", () => {
    expect(hostedRuntimePostgresOptions).toMatchObject({
      connect_timeout: 5,
      connection: {
        idle_in_transaction_session_timeout: 30_000,
        lock_timeout: 5_000,
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
        lock_timeout: 5_000,
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
        "postgresql://user:secret@ep-preview-pooler.us-east-2.aws.neon.tech/app?sslmode=require"
      )
    ).toContain("ep-preview-pooler");
    expect(parseHostedDatabaseUrl("postgresql://localhost/app")).toBe(
      "postgresql://localhost/app"
    );
    expect(() =>
      parseHostedDatabaseUrl(
        "postgresql://user:secret@ep-preview.us-east-2.aws.neon.tech/app?sslmode=require"
      )
    ).toThrow("pooled endpoint");
    expect(() =>
      parseHostedDatabaseUrl(
        "postgresql://user:secret@ep-preview-pooler.us-east-2.aws.neon.tech/app?sslmode=disable"
      )
    ).toThrow("requires TLS");
  });

  it("rejects malformed, non-PostgreSQL, and secret-frame-breaking values", () => {
    for (const value of [
      "not-a-url",
      "mysql://localhost/app",
      "postgresql://localhost/app\n",
    ]) {
      expect(() => parseHostedDatabaseUrl(value)).toThrow();
    }
  });
});
