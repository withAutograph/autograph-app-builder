/* oxlint-disable eslint/no-await-in-loop, promise/avoid-new -- Bounded IPC coordinates real PostgreSQL child-process contention. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { BuilderProvisionAuthority } from "../../../../lib/provisioning/journal";
import type { HostedOperatorPlan } from "../../../../lib/provisioning/hosted-operator-contract";

import { hostedTenantAuthoritySchema } from "../../../../lib/db/hosted-admin";
// oxlint-disable-next-line sonarjs/no-wildcard-import -- The store requires the complete schema for its canonical database type.
import * as schema from "../../../../lib/db/schema";
import {
  operatorPlanDigest,
  hostedOperatorPlanSchema,
} from "../../../../lib/provisioning/hosted-operator-contract";
import { createPostgresHostedOperatorResourceLease } from "../../../../lib/provisioning/postgres-hosted-operator-resource-lease";
import { createPostgresHostedRuntimeJournalStore } from "../../../../lib/provisioning/postgres-hosted-runtime-journal";
import type { HostedRuntimeTarget } from "../../../../lib/provisioning/hosted-runtime-journal";
import { hostedRuntimeTargetSchema } from "../../../../lib/provisioning/hosted-runtime-journal";
import { z } from "zod";

const childTimeoutMs = 20_000;
const eventPrefix = "A515_PROCESS_EVENT ";
const fixtureNow = () => Date.now();

interface ProofInput {
  databaseUrl: string;
  authority: BuilderProvisionAuthority;
  target: HostedRuntimeTarget;
  plan: HostedOperatorPlan;
}

const workerConfigSchema = z.strictObject({
  authority: hostedTenantAuthoritySchema,
  databaseUrl: z.string().min(1),
  leaseExpiresAt: z.iso.datetime({ offset: true }).optional(),
  leaseId: z.string().optional(),
  operationRef: z.string().optional(),
  plan: hostedOperatorPlanSchema,
  raceLeaseId: z.string().optional(),
  raceRevision: z.number().int().positive().optional(),
  role: z.enum(["holder", "contender"]),
  staleRevision: z.number().int().positive().optional(),
  target: hostedRuntimeTargetSchema,
});

const workerEventSchema = z.strictObject({
  applicationName: z.string().optional(),
  callbackStarted: z.boolean().optional(),
  fenceGeneration: z.number().optional(),
  kind: z.enum([
    "WORKER_BOOTED",
    "DATABASE_READY",
    "HOLDER_RESERVED",
    "HOLDER_CAS_RESULT",
    "HOLDER_READY",
    "CONTENDER_RACE_READY",
    "CONTENDER_CAS_RESULT",
    "CONTENDER_STARTED",
    "LEASE_EXPIRED",
    "STALE_LEASE_UNEXPECTEDLY_ALLOWED",
    "CONTENDER_ERROR",
    "STALE_CALLBACK_STARTED",
    "STALE_LEASE_BLOCKED",
    "RECOVERY_CALLBACK_STARTED",
    "CONTENDER_FINISHED",
  ]),
  leaseExpiresAt: z.string().optional(),
  leaseId: z.string().optional(),
  operationRef: z.string().optional(),
  revision: z.number().optional(),
  role: z.enum(["holder", "contender"]).optional(),
  staleCasLost: z.boolean().optional(),
  staleRevision: z.number().optional(),
  success: z.boolean().optional(),
});

interface WorkerEvent {
  applicationName?: string;
  callbackStarted?: boolean;
  fenceGeneration?: number;
  kind: z.infer<typeof workerEventSchema>["kind"];
  leaseExpiresAt?: string;
  leaseId?: string;
  operationRef?: string;
  revision?: number;
  role?: "holder" | "contender";
  staleCasLost?: boolean;
  staleRevision?: number;
  success?: boolean;
}

const workerConfig = () => {
  const raw = process.env.A515_PROCESS_PROOF_WORKER;
  if (raw === undefined) {
    return null;
  }
  try {
    return workerConfigSchema.parse(JSON.parse(raw));
  } catch {
    throw new Error("Hosted operator process proof worker configuration is invalid.");
  }
};

const emit = (event: WorkerEvent) =>
  process.stdout.write(`${eventPrefix}${JSON.stringify(event)}\n`);

const waitForCommand = (commandName: string) =>
  new Promise<void>((resolve, reject) => {
    let timeout: NodeJS.Timeout | null = null;
    const onData = (chunk: Buffer | string) => {
      const text = String(chunk);
      if (text.split(/\r?\n/u).some((line) => line.trim() === commandName)) {
        process.stdin.off("data", onData);
        if (timeout !== null) {
          clearTimeout(timeout);
        }
        resolve();
      }
    };
    timeout = setTimeout(() => {
      process.stdin.off("data", onData);
      reject(new Error("Process proof worker command timed out."));
    }, childTimeoutMs);
    process.stdin.on("data", onData);
    process.stdin.resume();
  });

const runWorker = async (config: Exclude<ReturnType<typeof workerConfig>, null>) => {
  emit({ kind: "WORKER_BOOTED", role: config.role });
  const sql = postgres(config.databaseUrl, { max: 2 });
  const database = drizzle(sql, { schema });
  const store = createPostgresHostedRuntimeJournalStore(database);
  try {
    await sql`select 1 as connected`;
    emit({ kind: "DATABASE_READY", role: config.role });
    if (config.role === "holder") {
      const operationRef = randomUUID();
      const leaseId = randomUUID();
      const createdAt = new Date(fixtureNow());
      const reserved = await store.reserve({
        approvedByCallId: `a515-process-proof-${randomUUID()}`,
        authority: config.authority,
        now: createdAt,
        operator: {
          mode: "protected-operator-v1",
          operationRef,
          plan: config.plan,
          planDigest: operatorPlanDigest(config.plan),
          receipts: [],
        },
        target: config.target,
      });
      const leaseExpiresAt = new Date(fixtureNow() + 60_000).toISOString();
      emit({
        kind: "HOLDER_RESERVED",
        leaseExpiresAt,
        leaseId,
        operationRef,
        revision: reserved.revision,
      });
      await waitForCommand("RACE_CAS");
      const firstClaim = await store.compareAndSet({
        authority: config.authority,
        expectedRevision: reserved.revision,
        now: createdAt,
        record: { ...reserved.record, leaseExpiresAt, leaseId },
        target: config.target,
      });
      emit({ kind: "HOLDER_CAS_RESULT", success: firstClaim !== undefined });
      let claimed = firstClaim;
      if (claimed === undefined) {
        const winner = await store.read({ authority: config.authority, target: config.target });
        assert.ok(winner, "a competing CAS winner must remain readable");
        claimed = await store.compareAndSet({
          authority: config.authority,
          expectedRevision: winner.revision,
          now: new Date(fixtureNow()),
          record: { ...winner.record, leaseExpiresAt, leaseId },
          target: config.target,
        });
      }
      assert.ok(
        claimed,
        "first process must claim the raced journal row before allocating its fence",
      );
      const allocated = await store.reserveFenceGeneration({
        authority: config.authority,
        expectedRevision: claimed.revision,
        leaseId,
        now: new Date(fixtureNow()),
        operationRef,
        target: config.target,
      });
      assert.ok(allocated, "first process must allocate a fence generation by journal CAS");
      const fenceGeneration = allocated.record.operator?.fenceGeneration;
      assert.ok(fenceGeneration !== undefined, "fence generation must be committed in the journal");
      const applicationName = `a515_process_holder_${randomUUID()}`;
      const withLease = createPostgresHostedOperatorResourceLease({
        openLockClient: (onConnectionClosed) =>
          postgres(config.databaseUrl, {
            connection: { application_name: applicationName },
            max: 1,
            onclose: onConnectionClosed,
          }),
        store,
      });
      await withLease(
        { authority: config.authority, operationRef, plan: config.plan, target: config.target },
        async (assertFence) => {
          await assertFence();
          emit({
            applicationName,
            fenceGeneration,
            kind: "HOLDER_READY",
            leaseExpiresAt: allocated.record.leaseExpiresAt,
            leaseId,
            operationRef,
            revision: allocated.revision,
            staleRevision: reserved.revision,
          });
          await waitForCommand("KILL_HOLDER");
        },
      );
    } else {
      const contenderConfig = workerConfigSchema
        .extend({
          leaseExpiresAt: z.iso.datetime({ offset: true }),
          leaseId: z.string(),
          operationRef: z.string(),
          raceLeaseId: z.string(),
          raceRevision: z.number().int().positive(),
          staleRevision: z.number().int().positive(),
        })
        .parse(config);
      const beforeRace = await store.read({
        authority: contenderConfig.authority,
        target: contenderConfig.target,
      });
      assert.ok(beforeRace, "contender must read the reserved journal row before racing its CAS");
      emit({ kind: "CONTENDER_RACE_READY" });
      await waitForCommand("RACE_CAS");
      const racedClaim = await store.compareAndSet({
        authority: config.authority,
        expectedRevision: contenderConfig.raceRevision,
        now: new Date(fixtureNow()),
        record: {
          ...beforeRace.record,
          leaseExpiresAt: contenderConfig.leaseExpiresAt,
          leaseId: contenderConfig.raceLeaseId,
        },
        target: config.target,
      });
      emit({ kind: "CONTENDER_CAS_RESULT", success: racedClaim !== undefined });
      await waitForCommand("LOCK_CONTEND_START");
      const applicationName = `a515_process_contender_${randomUUID()}`;
      const staleWrite = await store.compareAndSet({
        authority: contenderConfig.authority,
        expectedRevision: contenderConfig.staleRevision,
        now: new Date(fixtureNow()),
        record: {
          approvedByCallId: "stale-process-claim",
          kind: "app-runtime",
          request: contenderConfig.target,
          status: "pending",
          step: "reserved",
          version: 1,
        },
        target: contenderConfig.target,
      });
      assert.equal(
        staleWrite,
        undefined,
        "competing process must lose the already-claimed CAS revision",
      );
      let clock = fixtureNow();
      process.stdin.on("data", (chunk: Buffer | string) => {
        for (const line of String(chunk).split(/\r?\n/u)) {
          if (line.trim() === "EXPIRE_LEASE") {
            clock = Date.parse(contenderConfig.leaseExpiresAt) + 1;
            emit({ kind: "LEASE_EXPIRED" });
          }
          if (line.trim() === "RESET_CLOCK") {
            clock = fixtureNow();
          }
        }
      });
      const withLease = createPostgresHostedOperatorResourceLease({
        openLockClient: (onConnectionClosed) =>
          postgres(config.databaseUrl, {
            connection: { application_name: applicationName },
            max: 1,
            onclose: onConnectionClosed,
          }),
        now: () => clock,
        store,
      });
      emit({ applicationName, kind: "CONTENDER_STARTED", staleCasLost: true });
      let staleCallbackStarted = false;
      try {
        await withLease(
          {
            authority: contenderConfig.authority,
            operationRef: contenderConfig.operationRef,
            plan: contenderConfig.plan,
            target: contenderConfig.target,
          },
          async (assertFence) => {
            staleCallbackStarted = true;
            await assertFence();
            emit({ kind: "STALE_CALLBACK_STARTED" });
          },
        );
        emit({ kind: "STALE_LEASE_UNEXPECTEDLY_ALLOWED" });
      } catch (error) {
        const expectedLeaseFailure =
          error instanceof Error &&
          [
            "Protected resource lease authority is unavailable.",
            "Protected resource lease fence is stale.",
          ].includes(error.message);
        if (!expectedLeaseFailure) {
          emit({ kind: "CONTENDER_ERROR" });
          throw error;
        }
        emit({ callbackStarted: staleCallbackStarted, kind: "STALE_LEASE_BLOCKED" });
      }
      await waitForCommand("RESUME");
      await withLease(
        {
          authority: contenderConfig.authority,
          operationRef: contenderConfig.operationRef,
          plan: contenderConfig.plan,
          target: contenderConfig.target,
        },
        async (assertFence) => {
          await assertFence();
          emit({ kind: "RECOVERY_CALLBACK_STARTED" });
        },
      );
      emit({ kind: "CONTENDER_FINISHED" });
    }
  } finally {
    try {
      await sql.end({ timeout: 2 });
    } catch {
      // The owning process is exiting after a bounded fixture cleanup attempt.
    }
    process.stdin.pause();
  }
};

const worker = workerConfig();
if (worker !== null) {
  await runWorker(worker);
}

class ProcessWorker {
  private readonly child: ChildProcess;
  private readonly exitPromise: Promise<void>;
  private readonly events: WorkerEvent[] = [];
  private readonly waiters: { kind: string; resolve: (event: WorkerEvent) => void }[] = [];
  private stderr = "";
  private readonly databaseUrl: string;

  constructor(config: Exclude<ReturnType<typeof workerConfig>, null>) {
    this.databaseUrl = config.databaseUrl;
    this.child = spawn(process.execPath, ["--import", "tsx", import.meta.filename], {
      cwd: path.resolve(import.meta.dirname, "../../../../"),
      env: { A515_PROCESS_PROOF_WORKER: JSON.stringify(config), PATH: process.env.PATH },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.exitPromise = new Promise<void>((resolve) => {
      this.child.once("exit", () => {
        resolve();
      });
    });
    const { stdout } = this.child;
    assert.ok(stdout, "worker stdout pipe must be available");
    stdout.setEncoding("utf-8");
    const lines = createInterface({ input: stdout });
    lines.on("line", (line) => {
      if (!line.startsWith(eventPrefix)) {
        return;
      }
      try {
        const result = workerEventSchema.safeParse(JSON.parse(line.slice(eventPrefix.length)));
        if (!result.success) {
          return;
        }
        const event = result.data;
        const waiting = this.waiters.findIndex((item) => item.kind === event.kind);
        if (waiting === -1) {
          this.events.push(event);
        } else {
          const [waiter] = this.waiters.splice(waiting, 1);
          assert.notEqual(waiter, undefined, "matching event waiter must exist");
          waiter.resolve(event);
        }
      } catch {
        // Malformed child output is ignored; the bounded event wait reports the worker failure.
      }
    });
    this.child.stderr?.setEncoding("utf-8");
    this.child.stderr?.on("data", (chunk: string) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-4096);
    });
    this.child.stderr?.resume();
  }

  async waitFor(kind: string): Promise<WorkerEvent> {
    const found = this.events.findIndex((event) => event.kind === kind);
    if (found !== -1) {
      const [event] = this.events.splice(found, 1);
      assert.notEqual(event, undefined, "matching worker event must exist");
      return event;
    }
    return await new Promise<WorkerEvent>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(
          new Error(
            `Process worker did not report ${kind}. Startup diagnostics: ${this.safeStderr()}`,
          ),
        );
      }, childTimeoutMs);
      this.waiters.push({
        kind,
        resolve: (event) => {
          clearTimeout(timeout);
          resolve(event);
        },
      });
    });
  }

  send(command: string) {
    this.child.stdin?.write(`${command}\n`);
  }

  kill() {
    this.child.kill("SIGKILL");
  }

  async exited() {
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      return;
    }
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.exitPromise,
        new Promise<void>((_resolve, reject) => {
          timeout = setTimeout(() => {
            this.child.kill("SIGKILL");
            reject(new Error("Process proof worker did not exit within its cleanup deadline."));
          }, childTimeoutMs);
        }),
      ]);
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    }
  }

  get pid() {
    return this.child.pid;
  }

  private safeStderr() {
    return this.stderr
      .replaceAll(this.databaseUrl, "<redacted database URL>")
      .replaceAll(/postgres(?:ql)?:\/\/(?<credentials>[^\s]+)/giu, "postgresql://<redacted>")
      .replaceAll(
        /(?<name>password|token|secret|api[_-]?key)=(?<value>[^\s&]+)/giu,
        "$<name>=<redacted>",
      )
      .slice(-1000);
  }
}

const expectNoLeakedApplication = async (sql: postgres.Sql, names: string[]) => {
  const rows = await sql<{ count: number }[]>`
    select count(*)::int as count
    from pg_stat_activity
    where application_name = any(${sql.array(names)})
  `;
  assert.equal(
    rows[0]?.count ?? 0,
    0,
    "closed or killed process must not retain a PostgreSQL backend",
  );
};

const expectActivityOutsideTransaction = async (sql: postgres.Sql, applicationName: string) => {
  const rows = await sql<{ state: string | null; xact_start: Date | null; lock_count: number }[]>`
    select activity.state, activity.xact_start,
      (select count(*)::int from pg_locks where pid = activity.pid and locktype = 'advisory' and granted) as lock_count
    from pg_stat_activity activity
    where activity.application_name = ${applicationName}
  `;
  assert.equal(rows.length, 1, "paused lock holder must have a visible PostgreSQL session");
  assert.equal(rows[0]?.state, "idle", "provider wait must not leave a transaction open");
  assert.equal(rows[0]?.xact_start, null, "provider wait must not span an active transaction");
  assert.ok(
    (rows[0]?.lock_count ?? 0) > 0,
    "paused holder must retain its actual resource advisory lock",
  );
};

const waitForLockWaiter = async (sql: postgres.Sql, applicationName: string) => {
  const deadline = Date.now() + childTimeoutMs;
  while (Date.now() < deadline) {
    const rows = await sql<{ waiting: boolean }[]>`
      select exists(
        select 1 from pg_locks locks
        join pg_stat_activity activity on activity.pid = locks.pid
        where activity.application_name = ${applicationName}
          and locks.locktype = 'advisory'
          and not locks.granted
      ) as waiting
    `;
    if (rows[0]?.waiting) {
      return;
    }
    await delay(20);
  }
  throw new Error("Competing process did not wait on the actual resource lock.");
};

export const proveJournalProcessRecovery = async (input: ProofInput) => {
  const plan = hostedOperatorPlanSchema.parse(input.plan);
  assert.equal(
    plan.selection.sessionId,
    input.target.sessionId,
    "plan and target must share the frozen session identity",
  );
  const sql = postgres(input.databaseUrl, {
    max: 2,
    connection: { application_name: `a515_process_probe_${randomUUID()}` },
  });
  const database = drizzle(sql, { schema });
  const store = createPostgresHostedRuntimeJournalStore(database);
  let holder: ProcessWorker | null = null;
  let contender: ProcessWorker | null = null;
  const appNames: string[] = [];
  try {
    holder = new ProcessWorker({
      authority: input.authority,
      databaseUrl: input.databaseUrl,
      plan,
      role: "holder",
      target: input.target,
    });
    await holder.waitFor("WORKER_BOOTED");
    await holder.waitFor("DATABASE_READY");
    const reserved = await holder.waitFor("HOLDER_RESERVED");
    const staleRevision = Number(reserved.revision);
    const operationRef = String(reserved.operationRef);
    const firstLeaseId = String(reserved.leaseId);
    const firstLeaseExpiresAt = String(reserved.leaseExpiresAt);
    assert.ok(staleRevision > 0 && operationRef.length > 0 && firstLeaseId.length > 0);

    contender = new ProcessWorker({
      authority: input.authority,
      databaseUrl: input.databaseUrl,
      leaseExpiresAt: firstLeaseExpiresAt,
      leaseId: firstLeaseId,
      operationRef,
      plan,
      role: "contender",
      staleRevision,
      raceLeaseId: randomUUID(),
      raceRevision: staleRevision,
      target: input.target,
    });
    await contender.waitFor("WORKER_BOOTED");
    await contender.waitFor("DATABASE_READY");
    await contender.waitFor("CONTENDER_RACE_READY");
    holder.send("RACE_CAS");
    contender.send("RACE_CAS");
    const [holderClaim, contenderClaim] = await Promise.all([
      holder.waitFor("HOLDER_CAS_RESULT"),
      contender.waitFor("CONTENDER_CAS_RESULT"),
    ]);
    assert.notEqual(
      holderClaim.success,
      contenderClaim.success,
      "two child processes contending on one journal revision must produce exactly one CAS winner",
    );

    const held = await holder.waitFor("HOLDER_READY");
    assert.ok(held.applicationName !== undefined);
    const holderAppName = held.applicationName;
    appNames.push(holderAppName);
    const revision = Number(held.revision);
    const fenceGeneration = Number(held.fenceGeneration);
    const leaseId = String(held.leaseId);
    const leaseExpiresAt = String(held.leaseExpiresAt);
    assert.ok(
      revision > staleRevision &&
        fenceGeneration > 0 &&
        leaseId.length > 0 &&
        holderAppName.length > 0,
    );
    await expectActivityOutsideTransaction(sql, holderAppName);

    const current = await store.read({ authority: input.authority, target: input.target });
    assert.ok(current?.record.operator, "holder must persist the real journal record");
    const opRef = current.record.operator.operationRef;
    assert.equal(opRef, operationRef);
    assert.equal(current.record.operator.fenceGeneration, fenceGeneration);
    assert.equal(current.record.leaseId, leaseId);
    assert.equal(current.record.operator.planDigest, operatorPlanDigest(plan));
    assert.deepEqual(
      current.record.operator.plan,
      plan,
      "the frozen plan must survive the first process and CAS race",
    );
    assert.ok(leaseExpiresAt.length > 0);

    contender.send("LOCK_CONTEND_START");
    const started = await contender.waitFor("CONTENDER_STARTED");
    assert.equal(
      started.staleCasLost,
      true,
      "only the first process may claim the shared journal revision",
    );
    const contenderAppName = String(started.applicationName);
    appNames.push(contenderAppName);
    await waitForLockWaiter(sql, contenderAppName);
    await expectActivityOutsideTransaction(sql, holderAppName);

    contender.send("EXPIRE_LEASE");
    await contender.waitFor("LEASE_EXPIRED");
    holder.kill();
    await holder.exited();
    const stale = await contender.waitFor("STALE_LEASE_BLOCKED");
    assert.equal(
      stale.kind,
      "STALE_LEASE_BLOCKED",
      "expired lease must be rejected after lock acquisition",
    );
    assert.equal(
      stale.callbackStarted,
      false,
      "expired lease must be rejected before effects can begin",
    );

    const afterCrash = await store.read({ authority: input.authority, target: input.target });
    assert.ok(afterCrash?.record.operator);
    assert.equal(afterCrash.record.operator.operationRef, opRef);
    assert.equal(afterCrash.record.operator.fenceGeneration, fenceGeneration);
    const resumedLeaseId = randomUUID();
    const renewed = await store.compareAndSet({
      authority: input.authority,
      expectedRevision: afterCrash.revision,
      now: new Date(),
      record: {
        ...afterCrash.record,
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        leaseId: resumedLeaseId,
      },
      target: input.target,
    });
    assert.ok(renewed, "replacement process must claim an explicitly renewed lease by CAS");
    assert.equal(renewed.record.operator?.operationRef, opRef);
    assert.equal(renewed.record.operator?.fenceGeneration, fenceGeneration);
    assert.equal(renewed.record.operator?.planDigest, operatorPlanDigest(plan));
    assert.deepEqual(
      renewed.record.operator?.plan,
      plan,
      "lease replacement must retain the exact approved plan",
    );
    const staleSave = await store.compareAndSet({
      authority: input.authority,
      expectedRevision: afterCrash.revision,
      now: new Date(),
      record: afterCrash.record,
      target: input.target,
    });
    assert.equal(
      staleSave,
      undefined,
      "crashed process revision cannot overwrite the resumed lease",
    );

    contender.send("RESET_CLOCK");
    contender.send("RESUME");
    await contender.waitFor("RECOVERY_CALLBACK_STARTED");
    await contender.waitFor("CONTENDER_FINISHED");
    await contender.exited();
    await expectNoLeakedApplication(sql, appNames);
    return {
      cas: "one claimant; stale contender rejected",
      fenceGeneration,
      identity: { operationRef: opRef, sessionId: input.target.sessionId },
      lock: "cross-process wait observed; SIGKILL released holder lock; replacement acquired and closed",
      providerWaitTransaction: "pg_stat_activity state=idle and xact_start=NULL while lock held",
      recovery:
        "expired lease blocked callback; renewed lease resumed same operation and generation",
      staleRevisionWrite: "rejected",
    } as const;
  } finally {
    if (holder !== null) {
      holder.kill();
      try {
        await holder.exited();
      } catch {
        // Preserve the original proof error after the child cleanup deadline.
      }
    }
    if (contender !== null) {
      contender.kill();
      try {
        await contender.exited();
      } catch {
        // Preserve the original proof error after the child cleanup deadline.
      }
    }
    try {
      await expectNoLeakedApplication(sql, appNames);
    } catch {
      // Preserve the primary proof result; cleanup was attempted above.
    }
    try {
      await sql.end({ timeout: 2 });
    } catch {
      // Preserve the primary proof result after bounded database cleanup.
    }
  }
};
