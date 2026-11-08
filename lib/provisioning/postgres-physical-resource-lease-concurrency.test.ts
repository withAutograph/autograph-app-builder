/* oxlint-disable promise/avoid-new, promise/prefer-await-to-callbacks -- A test-owned PostgreSQL cluster and deferred callbacks expose real advisory-lock contention. */
/* oxlint-disable eslint/no-await-in-loop, react-doctor/async-await-in-loop -- Bounded polling observes this fixture's actual PostgreSQL lock queue. */
/* oxlint-disable eslint/require-await -- Controlled callbacks expose the asynchronous production lease ports. */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createPostgresPhysicalResourceLease } from "./postgres-physical-resource-lease";
import type {
  PhysicalResourceFence,
  PhysicalResourceLeaseInput,
} from "./postgres-physical-resource-lease";

const tools = [
  "/Applications/Postgres.app/Contents/Versions/17/bin",
  "/opt/homebrew/opt/postgresql@17/bin",
  "/usr/lib/postgresql/17/bin",
].find((candidate) => {
  try {
    return /PostgreSQL\) 17\./u.test(
      execFileSync(path.join(candidate, "postgres"), ["--version"], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
  } catch {
    return false;
  }
});
const slot = "repository-production:fixture-repository:fixture-app";
const fence: PhysicalResourceFence = {
  operationRef: "fixture-operation",
  leaseId: "fixture-lease",
  fenceGeneration: 1,
};
let root: string | undefined;
let started = false;
let databaseUrl: string;
let admin: ReturnType<typeof postgres> | undefined;

describe.skipIf(tools === undefined)(
  "automatic completion against actual PostgreSQL advisory locks",
  () => {
    beforeAll(async () => {
      if (tools === undefined) {
        throw new Error("Owned PostgreSQL tools are unavailable.");
      }
      const port = await new Promise<number>((resolve, reject) => {
        const server = createServer();
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          const address = z.object({ port: z.number().int().positive() }).parse(server.address());
          server.close((error) => {
            if (error === undefined) {
              resolve(address.port);
            } else {
              reject(error);
            }
          });
        });
      });
      root = await mkdtemp(path.join(tmpdir(), "builder-completion-pg-"));
      const data = path.join(root, "data");
      const password = randomBytes(24).toString("hex");
      const passwordFile = path.join(root, "password");
      await writeFile(passwordFile, password, { mode: 0o600 });
      execFileSync(
        path.join(tools, "initdb"),
        [
          "-D",
          data,
          "--username=fixture_admin",
          "--auth=scram-sha-256",
          `--pwfile=${passwordFile}`,
          "--no-locale",
        ],
        { stdio: "pipe" },
      );
      execFileSync(
        path.join(tools, "pg_ctl"),
        [
          "-D",
          data,
          "-l",
          path.join(root, "postgres.log"),
          "-o",
          `-h 127.0.0.1 -p ${port} -k ''`,
          "-w",
          "start",
        ],
        { stdio: "pipe" },
      );
      started = true;
      databaseUrl = `postgresql://fixture_admin:${password}@127.0.0.1:${port}/postgres`;
      admin = postgres(databaseUrl, { max: 1, prepare: false });
    });
    afterAll(async () => {
      await admin?.end({ timeout: 2 });
      if (started && root !== undefined && tools !== undefined) {
        execFileSync(
          path.join(tools, "pg_ctl"),
          ["-D", path.join(root, "data"), "-m", "immediate", "-w", "stop"],
          { stdio: "pipe" },
        );
      }
      if (root !== undefined) {
        await rm(root, { recursive: true, force: true });
      }
    });
    const lease = () =>
      createPostgresPhysicalResourceLease({
        openLockClient: (onclose) =>
          postgres(databaseUrl, {
            max: 1,
            idle_timeout: 0,
            max_lifetime: 0,
            prepare: false,
            onclose,
            connection: { lock_timeout: 750, statement_timeout: 2000 },
          }),
      });
    const lockCounts = async () => {
      if (admin === undefined) {
        throw new Error("Missing owned PostgreSQL fixture.");
      }
      const [counts] = await admin<{ held: number; waiting: number }[]>`
      select count(*) filter (where granted)::int as held,
             count(*) filter (where not granted)::int as waiting
      from pg_locks where locktype = 'advisory'
        and classid::bigint = ((hashtextextended(${slot}, 0) >> 32) & 4294967295)
        and objid::bigint = (hashtextextended(${slot}, 0) & 4294967295)
        and objsubid = 1
    `;
      return z.object({ held: z.number(), waiting: z.number() }).parse(counts);
    };

    it("coalesces concurrent automatic callbacks without queued locks, initialization or effects", async () => {
      const entered = Promise.withResolvers<null>();
      const release = Promise.withResolvers<null>();
      let retained: (() => Promise<void>) | undefined;
      const holder = lease()(
        { lockKeys: [slot], readCurrentFence: async () => ({ ...fence }) },
        async (assertFence) => {
          retained = assertFence;
          entered.resolve(null);
          await release.promise;
          await assertFence();
        },
      );
      await entered.promise;
      let initialized = 0;
      let readFence = 0;
      let effects = 0;
      let finished = 0;
      let sawWaiting = false;
      const input: PhysicalResourceLeaseInput = {
        lockKeys: [slot],
        tryAcquire: true,
        initializeUnderLock: async () => {
          initialized += 1;
        },
        readCurrentFence: async () => {
          readFence += 1;
          return { ...fence };
        },
      };
      const contenders = Array.from({ length: 24 }, async () => {
        try {
          await lease()(input, async () => {
            effects += 1;
          });
          return "unexpected-acquisition";
        } catch (error) {
          return error instanceof Error ? error.name : "unexpected-error";
        } finally {
          finished += 1;
        }
      });
      try {
        while (finished < contenders.length) {
          const counts = await lockCounts();
          sawWaiting ||= counts.waiting !== 0;
          await new Promise((resolve) => {
            setTimeout(resolve, 5);
          });
        }
        expect(await Promise.all(contenders)).toEqual(
          Array.from({ length: 24 }, () => "PhysicalResourceLeaseBusyError"),
        );
        expect(sawWaiting).toBe(false);
        expect(await lockCounts()).toEqual({ held: 1, waiting: 0 });
        expect({ initialized, readFence, effects }).toEqual({
          initialized: 0,
          readFence: 0,
          effects: 0,
        });
        // A different app still progresses while this app's original completion owns its slot.
        await lease()({ ...input, lockKeys: [`${slot}-different-app`] }, async (assertFence) => {
          await assertFence();
          effects += 1;
        });
        expect(effects).toBe(1);
      } finally {
        release.resolve(null);
        await Promise.allSettled(contenders);
        await holder;
      }
      expect(await lockCounts()).toEqual({ held: 0, waiting: 0 });
      await expect(retained?.()).rejects.toThrow("session was lost");
      await lease()(input, async (assertFence) => {
        await assertFence();
        effects += 1;
      });
      expect(initialized).toBe(2);
      expect(effects).toBe(2);
    });

    it("retains blocking serialization for an explicit operation and rejects revoked authority", async () => {
      const entered = Promise.withResolvers<null>();
      const release = Promise.withResolvers<null>();
      let winner = false;
      const holder = lease()(
        { lockKeys: [slot], readCurrentFence: async () => ({ ...fence }) },
        async () => {
          entered.resolve(null);
          await release.promise;
        },
      );
      await entered.promise;
      const next = lease()(
        { lockKeys: [slot], readCurrentFence: async () => ({ ...fence }) },
        async (assertFence) => {
          await assertFence();
          winner = true;
        },
      );
      const deadline = Date.now() + 500;
      let waiting = 0;
      try {
        while (waiting === 0 && Date.now() < deadline) {
          const { waiting: count } = await lockCounts();
          waiting = count;
          await new Promise((resolve) => {
            setTimeout(resolve, 5);
          });
        }
        expect(waiting).toBe(1);
        expect(winner).toBe(false);
      } finally {
        release.resolve(null);
        await holder;
        await next;
      }
      expect(winner).toBe(true);
      let authorized = true;
      let effects = 0;
      await expect(
        lease()(
          {
            lockKeys: [slot],
            tryAcquire: true,
            readCurrentFence: async () => {
              if (!authorized) {
                throw new Error("fixture authority revoked");
              }
              return { ...fence };
            },
          },
          async (assertFence) => {
            authorized = false;
            await assertFence();
            effects += 1;
          },
        ),
      ).rejects.toThrow("fixture authority revoked");
      expect(effects).toBe(0);
      expect(await lockCounts()).toEqual({ held: 0, waiting: 0 });
    });
  },
);
