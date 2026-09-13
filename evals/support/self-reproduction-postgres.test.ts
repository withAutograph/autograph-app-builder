import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { startSelfReproductionPostgres } from "./self-reproduction-postgres";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function stateRoot() {
  const root = await mkdtemp(join(tmpdir(), "eval-pg-test-"));
  roots.push(root);
  return root;
}
it("creates the actual application database before declaring ready and stops once", async () => {
  const run = vi.fn<(command: string, args: string[]) => Promise<void>>(() => Promise.resolve());
  const database = await startSelfReproductionPostgres({
    stateRoot: await stateRoot(),
    port: 15_432,
    run,
  });
  expect(run.mock.calls.map((call) => call[0])).toEqual(["initdb", "pg_ctl", "createdb", "psql"]);
  expect(run.mock.calls[1][1]).toContain("-h 127.0.0.1 -p 15432");
  expect(run.mock.calls[2][1]).toContain("autograph_app_builder");
  await database.stop();
  await database.stop();
  expect(run).toHaveBeenCalledTimes(5);
});
it("stops PostgreSQL if database creation fails and preserves the failure", async () => {
  const failure = new Error("database creation failed");
  const run = vi.fn((command: string) =>
    command === "createdb" ? Promise.reject(failure) : Promise.resolve(),
  );
  await expect(
    startSelfReproductionPostgres({ stateRoot: await stateRoot(), port: 15_432, run }),
  ).rejects.toBe(failure);
  expect(run.mock.calls.map((call) => call[0])).toEqual(["initdb", "pg_ctl", "createdb", "pg_ctl"]);
});
it("does not stop an unrelated cluster after initialization fails", async () => {
  const run = vi.fn(() => Promise.reject(new Error("init failed")));
  await expect(
    startSelfReproductionPostgres({ stateRoot: await stateRoot(), port: 15_432, run }),
  ).rejects.toThrow("init failed");
  expect(run).toHaveBeenCalledTimes(1);
});
