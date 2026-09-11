import { resolve } from "node:path";

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

import { readPrivateDatabaseUrl } from "./private-database-url";
import { hostedTaskPostgresOptions } from "./postgres-connection-policy";

if (
  process.argv.length !== 4 ||
  process.argv[2] !== "--database-url-fd" ||
  process.argv[3] !== "0"
) {
  throw new Error("database:migrate requires its private database URL fd.");
}
const databaseUrl = readPrivateDatabaseUrl(0);

const sql = postgres(databaseUrl, hostedTaskPostgresOptions);
try {
  await migrate(drizzle(sql), {
    migrationsFolder: resolve("drizzle"),
  });
} finally {
  await sql.end({ timeout: 5 });
}
