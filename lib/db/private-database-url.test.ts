import { fstatSync, openSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { readPrivateDatabaseUrl } from "./private-database-url";
import { parseMigrationDatabaseUrl } from "./postgres-connection-policy";

it("reads direct migration URLs through the same closed, bounded private descriptor", () => {
  const root = mkdtempSync(path.join(tmpdir(), "migration-frame-"));
  const file = path.join(root, "frame");
  const url =
    "postgresql://fixture:synthetic@ep-fixture.us-east-2.aws.neon.tech/app?sslmode=require";
  try {
    writeFileSync(file, url, { mode: 0o600 });
    const fd = openSync(file, "r");
    expect(readPrivateDatabaseUrl(fd, parseMigrationDatabaseUrl)).toBe(url);
    expect(() => fstatSync(fd)).toThrow();
    expect(() => readPrivateDatabaseUrl(openSync(file, "r"))).toThrow("pooled endpoint");
    for (const frame of ["", `${url}\n`, "x".repeat(8193)]) {
      writeFileSync(file, frame);
      const invalidFd = openSync(file, "r");
      expect(() => readPrivateDatabaseUrl(invalidFd, parseMigrationDatabaseUrl)).toThrow();
      expect(() => fstatSync(invalidFd)).toThrow();
    }
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
