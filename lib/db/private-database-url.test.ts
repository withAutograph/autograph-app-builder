import { chmodSync, fstatSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseHostedDatabaseUrl, parseMigrationDatabaseUrl } from "./postgres-connection-policy";
import { readPrivateDatabaseUrl, readPrivateMigrationDatabaseUrl } from "./private-database-url";

const directUrl =
  "postgresql://migration_user:synthetic-password@ep-migration.us-east-1.aws.neon.tech/app?sslmode=require";
const pooledUrl =
  "postgresql://migration_user:synthetic-password@ep-migration-pooler.us-east-1.aws.neon.tech/app?sslmode=require";
const temporaryDirectories: string[] = [];

const privateFdFor = (value: string) => {
  const directory = mkdtempSync(path.join(tmpdir(), "builder-migration-url-"));
  chmodSync(directory, 0o700);
  temporaryDirectories.push(directory);
  const file = path.join(directory, "database-url");
  writeFileSync(file, value, { mode: 0o600 });
  return openSync(file, "r");
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("private migration database URL", () => {
  it("accepts a direct Neon URL unchanged while hosted application URLs still require pooling", () => {
    expect(parseMigrationDatabaseUrl(directUrl)).toBe(directUrl);
    expect(parseHostedDatabaseUrl(pooledUrl)).toBe(pooledUrl);
    expect(() => parseHostedDatabaseUrl(directUrl)).toThrow();
  });

  it("reads a synthetic direct URL from a private fd and closes the descriptor", () => {
    const fd = privateFdFor(directUrl);
    expect(readPrivateMigrationDatabaseUrl(fd)).toBe(directUrl);
    expect(() => fstatSync(fd)).toThrow();
  });

  it("keeps the existing private application reader pooled-only", () => {
    const fd = privateFdFor(directUrl);
    expect(() => readPrivateDatabaseUrl(fd)).toThrow();
    expect(() => fstatSync(fd)).toThrow();
  });

  it.each([
    ["a pooled endpoint", pooledUrl],
    ["an insecure direct endpoint", directUrl.replace("sslmode=require", "sslmode=disable")],
    ["a non-PostgreSQL protocol", directUrl.replace("postgresql:", "https:")],
  ])("rejects %s for migration before returning connection bytes", (_label, value) => {
    expect(() => parseMigrationDatabaseUrl(value)).toThrow();
  });

  it("closes an fd when migration URL policy validation fails", () => {
    const fd = privateFdFor(pooledUrl);
    expect(() => readPrivateMigrationDatabaseUrl(fd)).toThrow();
    expect(() => fstatSync(fd)).toThrow();
  });

  it.each([
    ["empty", ""],
    ["oversized", "x".repeat(8193)],
    ["malformed", `${directUrl}\n`],
  ])("closes the fd and rejects an %s secret frame", (_label, value) => {
    const fd = privateFdFor(value);
    expect(() => readPrivateMigrationDatabaseUrl(fd)).toThrow();
    expect(() => fstatSync(fd)).toThrow();
  });

  it("rejects an invalid fd before attempting to read or close it", () => {
    expect(() => readPrivateMigrationDatabaseUrl(-1)).toThrow();
  });
});
