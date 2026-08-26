import { closeSync, readSync } from "node:fs";
import { resolve } from "node:path";

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

if (
  process.argv.length !== 4 ||
  process.argv[2] !== "--database-url-fd" ||
  process.argv[3] !== "3"
) {
  throw new Error("database:migrate requires its private database URL fd.");
}
const frame = Buffer.alloc(8_193);
let length = 0;
try {
  while (length < frame.length) {
    const count = readSync(3, frame, length, frame.length - length, null);
    if (count === 0) break;
    length += count;
  }
} finally {
  closeSync(3);
}
if (length === 0 || length > 8_192) {
  throw new Error("The database URL secret frame was empty or oversized.");
}
const databaseUrl = frame.subarray(0, length).toString("utf8");
frame.fill(0);
if (/[\0\r\n]/u.test(databaseUrl)) {
  throw new Error("The database URL secret frame was malformed.");
}
const url = new URL(databaseUrl);
if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
  throw new Error("DATABASE_URL must use PostgreSQL.");
}

const sql = postgres(databaseUrl, {
  max: 1,
  connect_timeout: 5,
  idle_timeout: 5,
  prepare: false,
  onnotice: () => undefined,
});
try {
  await migrate(drizzle(sql), {
    migrationsFolder: resolve("drizzle"),
  });
} finally {
  await sql.end({ timeout: 5 });
}
