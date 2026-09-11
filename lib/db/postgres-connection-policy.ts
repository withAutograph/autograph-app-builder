import { z } from "zod";

export const hostedRuntimePostgresOptions = {
  max: 5,
  connect_timeout: 5,
  idle_timeout: 20,
  max_lifetime: 300,
  prepare: false,
  connection: {
    statement_timeout: 30_000,
    lock_timeout: 5_000,
    idle_in_transaction_session_timeout: 30_000,
  },
  onnotice: () => undefined,
} as const;

export const hostedTaskPostgresOptions = {
  max: 1,
  connect_timeout: 5,
  idle_timeout: 5,
  max_lifetime: 60,
  prepare: false,
  connection: {
    statement_timeout: 15_000,
    lock_timeout: 5_000,
    idle_in_transaction_session_timeout: 15_000,
  },
  onnotice: () => undefined,
} as const;

const databaseUrlSchema = z
  .string()
  .min(1)
  .max(8_192)
  .refine((value) => !/[\0\r\n]/u.test(value), "Malformed database URL.")
  .transform((value, context) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      context.addIssue({ code: "custom", message: "Invalid database URL." });
      return z.NEVER;
    }
    if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
      context.addIssue({
        code: "custom",
        message: "Hosted storage requires PostgreSQL.",
      });
      return z.NEVER;
    }
    if (url.hostname.endsWith(".neon.tech")) {
      const endpoint = url.hostname.split(".")[0] ?? "";
      if (!endpoint.endsWith("-pooler")) {
        context.addIssue({
          code: "custom",
          message: "Hosted Neon storage requires its pooled endpoint.",
        });
        return z.NEVER;
      }
      const sslMode = url.searchParams.get("sslmode");
      if (sslMode !== "require" && sslMode !== "verify-full") {
        context.addIssue({
          code: "custom",
          message: "Hosted Neon storage requires TLS.",
        });
        return z.NEVER;
      }
    }
    return value;
  });

export function parseHostedDatabaseUrl(value: unknown): string {
  return databaseUrlSchema.parse(value);
}
