import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hostedTaskPostgresOptions } from "./postgres-connection-policy";

const mocks = vi.hoisted(() => ({
  closeSync: vi.fn(),
  drizzle: vi.fn(),
  migrate: vi.fn(),
  postgres: vi.fn(),
  readSync: vi.fn(),
  sqlEnd: vi.fn(),
}));
const directUrl =
  "postgresql://migration_user:synthetic-password@ep-migration.us-east-1.aws.neon.tech/app?sslmode=require";
const pooledUrl =
  "postgresql://migration_user:synthetic-password@ep-migration-pooler.us-east-1.aws.neon.tech/app?sslmode=require";
const originalArgv = [...process.argv];
const sql = { end: mocks.sqlEnd };
const migrationDb = { synthetic: "migration-db" };

const setArguments = (...args: string[]) => {
  process.argv.splice(0, process.argv.length, "node", "migrate.mts", ...args);
};
const configureSyntheticFd = (value: string) => {
  let remaining = Buffer.from(value);
  mocks.readSync.mockImplementation(
    (_fd: number, frame: Buffer, offset: number, length: number) => {
      const count = Math.min(length, remaining.length);
      remaining.copy(frame, offset, 0, count);
      remaining = remaining.subarray(count);
      return count;
    },
  );
};
const loadMigrationEntrypoint = async () => await import("./migrate.mts");

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  setArguments("--database-url-fd", "0");
  mocks.sqlEnd.mockImplementation(() => Promise.resolve());
  mocks.postgres.mockReturnValue(sql);
  mocks.drizzle.mockReturnValue(migrationDb);
  mocks.migrate.mockImplementation(() => Promise.resolve());
  configureSyntheticFd(directUrl);
  // oxlint-disable-next-line anti-slop/no-module-mocking -- Keep the real CLI entrypoint while isolating its network driver.
  vi.doMock("postgres", () => ({ default: mocks.postgres }));
  // oxlint-disable-next-line anti-slop/no-module-mocking -- Exercise the actual CLI against a local Drizzle port spy.
  vi.doMock("drizzle-orm/postgres-js", () => ({ drizzle: mocks.drizzle }));
  // oxlint-disable-next-line anti-slop/no-module-mocking -- Exercise the actual migration lifecycle without a database.
  vi.doMock("drizzle-orm/postgres-js/migrator", () => ({ migrate: mocks.migrate }));
  // oxlint-disable-next-line anti-slop/no-module-mocking -- Supply a synthetic fd0 frame and verify the production reader closes it.
  vi.doMock("node:fs", () => ({ closeSync: mocks.closeSync, readSync: mocks.readSync }));
});
afterEach(() => {
  process.argv.splice(0, process.argv.length, ...originalArgv);
  vi.doUnmock("postgres");
  vi.doUnmock("drizzle-orm/postgres-js");
  vi.doUnmock("drizzle-orm/postgres-js/migrator");
  vi.doUnmock("node:fs");
  vi.resetModules();
});

describe("database migration entrypoint", () => {
  it("passes direct URL bytes unchanged to postgres and Drizzle, then closes the driver", async () => {
    await loadMigrationEntrypoint();

    expect(mocks.readSync).toHaveBeenCalled();
    expect(mocks.closeSync).toHaveBeenCalledWith(0);
    expect(mocks.postgres).toHaveBeenCalledWith(directUrl, expect.any(Object));
    expect(mocks.postgres.mock.calls[0]?.[1]).toMatchObject({
      connect_timeout: hostedTaskPostgresOptions.connect_timeout,
      max: hostedTaskPostgresOptions.max,
      prepare: hostedTaskPostgresOptions.prepare,
    });
    expect(mocks.drizzle).toHaveBeenCalledWith(sql);
    expect(mocks.migrate).toHaveBeenCalledWith(migrationDb, {
      migrationsFolder: path.resolve("drizzle"),
    });
    expect(mocks.sqlEnd).toHaveBeenCalledWith({ timeout: 5 });
  });

  it.each([
    ["missing flag", []],
    ["wrong flag", ["--database-url", "0"]],
    ["nonzero fd", ["--database-url-fd", "1"]],
    ["extra argument", ["--database-url-fd", "0", "unexpected"]],
  ])("rejects %s before reading fd0", async (_label, args) => {
    setArguments(...args);
    await expect(loadMigrationEntrypoint()).rejects.toThrow(
      "database:migrate requires its private database URL fd.",
    );
    expect(mocks.readSync).not.toHaveBeenCalled();
    expect(mocks.closeSync).not.toHaveBeenCalled();
    expect(mocks.postgres).not.toHaveBeenCalled();
  });

  it.each([
    ["pooled Neon URL", pooledUrl],
    ["direct URL without TLS", directUrl.replace("sslmode=require", "sslmode=disable")],
  ])("rejects %s before creating a driver", async (_label, value) => {
    configureSyntheticFd(value);
    await expect(loadMigrationEntrypoint()).rejects.toThrow();
    expect(mocks.closeSync).toHaveBeenCalledWith(0);
    expect(mocks.postgres).not.toHaveBeenCalled();
    expect(mocks.drizzle).not.toHaveBeenCalled();
    expect(mocks.migrate).not.toHaveBeenCalled();
  });

  it("closes the postgres client after a Drizzle migration failure", async () => {
    const migrationFailure = new Error("synthetic migration failure");
    mocks.migrate.mockRejectedValueOnce(migrationFailure);

    await expect(loadMigrationEntrypoint()).rejects.toBe(migrationFailure);
    expect(mocks.postgres).toHaveBeenCalledWith(directUrl, expect.any(Object));
    expect(mocks.postgres.mock.calls[0]?.[1]).toMatchObject({
      connect_timeout: hostedTaskPostgresOptions.connect_timeout,
      max: hostedTaskPostgresOptions.max,
      prepare: hostedTaskPostgresOptions.prepare,
    });
    expect(mocks.sqlEnd).toHaveBeenCalledWith({ timeout: 5 });
  });
});
