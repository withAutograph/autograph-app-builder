import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

// oxlint-disable-next-line sonarjs/no-wildcard-import -- Preserve the complete Drizzle schema namespace and existing database return type.
import * as databaseSchema from "./schema";
import { hostedRuntimePostgresOptions, parseHostedDatabaseUrl } from "./postgres-connection-policy";

type Database = PostgresJsDatabase<typeof databaseSchema>;

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function openHostedPostgresDatabase(databaseUrl: string): Database {
  const client = postgres(parseHostedDatabaseUrl(databaseUrl), hostedRuntimePostgresOptions);
  return drizzle(client, { schema: databaseSchema });
}
