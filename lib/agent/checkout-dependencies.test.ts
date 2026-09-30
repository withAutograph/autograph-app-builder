// oxlint-disable eslint/require-await -- In-memory store operations and fixture failures implement asynchronous provider contracts.
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { SandboxSession } from "eve/sandbox";
import { ensureCheckoutDependencies } from "./checkout-dependencies";
import type { DependencyAttemptResult } from "./checkout-dependencies";
import { readValidationLogPage } from "../repository/validation-log";
import type {
  ValidationLogKey,
  ValidationLogReference,
  ValidationLogStore,
} from "../repository/validation-log";

const scope = (key: ValidationLogKey) =>
  JSON.stringify([key.sessionId, key.attemptDigest, key.command, key.channel, key.logId]);
const memoryStore = () => {
  const chunks = new Map<string, { content: string; digest: string }>();
  const manifests = new Map<string, ValidationLogReference>();
  const store: ValidationLogStore = {
    async getChunk(key, index) {
      return chunks.get(`${scope(key)}:${index}`);
    },
    async getReference(key) {
      return manifests.get(scope(key));
    },
    async publish(key, reference) {
      manifests.set(scope(key), reference);
    },
    async putChunk(key, index, content, digest) {
      chunks.set(`${scope(key)}:${index}`, { content, digest });
    },
    async removeStaged() {},
  };
  return { manifests, store };
};
const stream = (output: readonly string[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of output) {
        controller.enqueue(new TextEncoder().encode(part));
      }
      controller.close();
    },
  });
const openStream = (value: string) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode(value));
    },
  });
const process = (
  exitCode: number,
  stdout: readonly string[] = [],
  stderr: readonly string[] = [],
) => ({
  kill: vi.fn(async () => {
    /* The finished fixture owns no running process. */
  }),
  stderr: stream(stderr),
  stdout: stream(stdout),
  wait: vi.fn().mockResolvedValue({ exitCode }),
});
const input = (
  spawn: SandboxSession["spawn"],
  logStore?: ValidationLogStore,
): Parameters<typeof ensureCheckoutDependencies>[0] => ({
  checkoutIdentity: "selected-source-revision",
  logStore,
  root: "/workspace/repository",
  sandbox: { spawn },
  sessionId: "session-a",
});
const readAll = async (
  store: ValidationLogStore,
  attempt: DependencyAttemptResult,
  channel: "stdout" | "stderr",
) => {
  const reference = attempt.logs[channel];
  if (reference === undefined) {
    throw new Error("Missing durable reference");
  }
  const key = {
    attemptDigest: attempt.attemptDigest,
    channel,
    command: attempt.command,
    logId: reference.logId,
    sessionId: "session-a",
  };
  let cursor: string | undefined;
  let output = "";
  do {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Follow exact manifest-bound cursors.
    const page = await readValidationLogPage({ cursor, digest: reference.digest, key, store });
    output += page.content;
    cursor = page.nextCursor;
    expect(page.completion).toBe(reference.completion);
  } while (cursor !== undefined);
  expect(createHash("sha256").update(output).digest("hex")).toBe(reference.digest);
  return output;
};

describe("replacement checkout dependencies", () => {
  it("preserves the probe and reuses dependencies without installing", async () => {
    const { store } = memoryStore();
    const spawn = vi.fn().mockResolvedValue(process(0));
    const result = await ensureCheckoutDependencies(input(spawn, store));
    expect(result.status).toBe("reused");
    expect(result.attempts).toHaveLength(1);
    expect(spawn).toHaveBeenCalledExactlyOnceWith({
      command: "test -d node_modules/.bin",
      workingDirectory: "/workspace/repository",
    });
    expect(result.attempts[0]?.logs.stdout?.completion).toBe("complete");
  });

  it("streams independent channels beyond the excerpt, redacts split credentials, and reads after compute cleanup", async () => {
    const { store } = memoryStore();
    const output = `${"installed coût ❄️\n".repeat(10_000)}${"x".repeat(100_000)}\n`;
    const command = process(
      0,
      [output, "API_", "KEY=super-", "secret\n"],
      ["Bearer ", "private-value\nwarning: done\n"],
    );
    const spawn = vi.fn().mockResolvedValueOnce(process(1)).mockResolvedValueOnce(command);
    const result = await ensureCheckoutDependencies({
      ...input(spawn, store),
      requiredExecutable: "next",
    });
    expect(result.status).toBe("installed");
    expect(spawn).toHaveBeenNthCalledWith(1, {
      command: "test -x node_modules/.bin/next",
      workingDirectory: "/workspace/repository",
    });
    expect(spawn).toHaveBeenNthCalledWith(2, {
      command: "bun install --frozen-lockfile",
      workingDirectory: "/workspace/repository",
    });
    const [, install] = result.attempts;
    if (install === undefined) {
      throw new Error("Missing install attempt");
    }
    expect(install.excerpt.length).toBeLessThanOrEqual(2400);
    expect(install.truncated).toBe(true);
    await command.kill();
    const stdout = await readAll(store, install, "stdout");
    const stderr = await readAll(store, install, "stderr");
    expect(stdout).toBe(`${output}API_KEY=[REDACTED]\n`);
    expect(stderr).toBe("Bearer [REDACTED]\nwarning: done\n");
  });

  it("saves complete nonzero output before surfacing failure and binds a new digest to every execution", async () => {
    const { store } = memoryStore();
    const saved: DependencyAttemptResult[] = [];
    const spawn = vi
      .fn()
      .mockImplementation(async () => process(1, [], ["frozen lockfile mismatch\n"]));
    await expect(
      ensureCheckoutDependencies({
        ...input(spawn, store),
        onAttempt: (attempt) => {
          saved.push(attempt);
        },
      }),
    ).rejects.toThrow(/bun install --frozen-lockfile.*status 1/u);
    expect(saved).toHaveLength(2);
    const [, install] = saved;
    if (install === undefined) {
      throw new Error("Missing install attempt");
    }
    expect(install.completion).toBe("complete");
    expect(await readAll(store, install, "stderr")).toContain("frozen lockfile mismatch");
    await expect(
      ensureCheckoutDependencies({
        ...input(spawn, store),
        onAttempt: (attempt) => {
          saved.push(attempt);
        },
      }),
    ).rejects.toThrow();
    expect(new Set(saved.map((attempt) => attempt.attemptDigest)).size).toBe(4);
    const reference = install.logs.stderr;
    if (reference === undefined) {
      throw new Error("Missing reference");
    }
    await expect(
      readValidationLogPage({
        digest: reference.digest,
        key: {
          attemptDigest: install.attemptDigest,
          channel: "stderr",
          command: "dependency-probe",
          logId: reference.logId,
          sessionId: "session-a",
        },
        store,
      }),
    ).rejects.toThrow("unavailable");
  });

  it.each(["provider", "cancellation"])(
    "publishes captured %s interruption output without calling it complete",
    async (mode) => {
      const { store } = memoryStore();
      const controller = new AbortController();
      let stdoutController: ReadableStreamDefaultController<Uint8Array>;
      let stderrController: ReadableStreamDefaultController<Uint8Array>;
      const interrupted = {
        kill: vi.fn(async () => {
          stdoutController.close();
          stderrController.close();
        }),
        stderr: new ReadableStream<Uint8Array>({
          start(c) {
            stderrController = c;
            c.enqueue(new TextEncoder().encode("API_KEY=split"));
          },
        }),
        stdout: new ReadableStream<Uint8Array>({
          start(c) {
            stdoutController = c;
            c.enqueue(new TextEncoder().encode("partial install\n"));
          },
        }),
        async wait() {
          await Promise.resolve();
          if (mode === "cancellation") {
            controller.abort(new Error("cancelled"));
          }
          throw new Error("provider disconnected");
        },
      };
      const saved: DependencyAttemptResult[] = [];
      const spawn = vi.fn().mockResolvedValueOnce(process(1)).mockResolvedValueOnce(interrupted);
      await expect(
        ensureCheckoutDependencies({
          ...input(spawn, store),
          onAttempt: (attempt) => {
            saved.push(attempt);
          },
          signal: controller.signal,
        }),
      ).rejects.toThrow("was interrupted");
      const [, install] = saved;
      if (install === undefined) {
        throw new Error("Missing install attempt");
      }
      expect(install.logs.stdout?.completion).toBe("interrupted");
      expect(await readAll(store, install, "stdout")).toBe("partial install\n");
      expect(await readAll(store, install, "stderr")).toBe("API_KEY=[REDACTED]");
      expect(interrupted.kill).toHaveBeenCalledOnce();
    },
  );

  it.each(["provider", "cancellation", "cleanup-hang"])(
    "finishes %s interruption capture when cleanup fails and pipes remain open",
    async (mode) => {
      const { store } = memoryStore();
      const controller = new AbortController();
      const neverFinished = Promise.withResolvers<{ exitCode: number }>();
      const neverKilled = Promise.withResolvers<boolean>();
      const command = {
        kill: vi.fn(async () => {
          if (mode === "cleanup-hang") {
            await neverKilled.promise;
          }
          throw new Error("provider unavailable");
        }),
        stderr: openStream("partial stderr\n"),
        stdout: openStream("partial stdout\n"),
        async wait() {
          await Promise.resolve();
          if (mode === "cancellation") {
            controller.abort(new Error("cancelled"));
            return await neverFinished.promise;
          }
          throw new Error("provider lost");
        },
      };
      const saved: DependencyAttemptResult[] = [];
      const spawn = vi.fn().mockResolvedValueOnce(process(1)).mockResolvedValueOnce(command);
      await expect(
        ensureCheckoutDependencies({
          ...input(spawn, store),
          onAttempt: (attempt) => {
            saved.push(attempt);
          },
          signal: controller.signal,
        }),
      ).rejects.toThrow("was interrupted");
      const [, install] = saved;
      if (install === undefined) {
        throw new Error("Missing interrupted install attempt");
      }
      expect(install.logs.stdout?.completion).toBe("interrupted");
      expect(await readAll(store, install, "stdout")).toBe("partial stdout\n");
      expect(await readAll(store, install, "stderr")).toBe("partial stderr\n");
      expect(command.kill).toHaveBeenCalledOnce();
    },
  );

  it("continues draining after failed storage, preserves a readable prefix, and never reruns a valid install", async () => {
    const { store } = memoryStore();
    const put = store.putChunk;
    store.putChunk = vi.fn<ValidationLogStore["putChunk"]>(async (key, index, content, digest) => {
      if (key.command === "dependency-install" && key.channel === "stdout" && index === 1) {
        throw new Error("storage outage");
      }
      await put(key, index, content, digest);
    });
    const output = "resolved package\n".repeat(20_000);
    const spawn = vi
      .fn()
      .mockResolvedValueOnce(process(1))
      .mockResolvedValueOnce(process(0, [output, "API_KEY=private\n"], ["install done\n"]));
    const result = await ensureCheckoutDependencies(input(spawn, store));
    const [, install] = result.attempts;
    if (install === undefined) {
      throw new Error("Missing install attempt");
    }
    expect(result.status).toBe("installed");
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(install.durability).toBe("unavailable");
    expect(install.logs.stdout?.completion).toBe("unavailable");
    expect(await readAll(store, install, "stdout")).toBe(output.slice(0, 32 * 1024));
    expect(await readAll(store, install, "stderr")).toBe("install done\n");
    expect(install.excerpt).not.toContain("private");
  });

  it("awaits storage backpressure while the other channel drains independently", async () => {
    const { store } = memoryStore();
    const put = store.putChunk;
    const { promise: blocked, resolve: release } = Promise.withResolvers<boolean>();
    const { promise: stdoutSeen, resolve: stdoutStarted } = Promise.withResolvers<boolean>();
    const { promise: stderrSeen, resolve: stderrStarted } = Promise.withResolvers<boolean>();
    let stdoutWrites = 0;
    store.putChunk = async (key, index, content, digest) => {
      if (key.command === "dependency-install") {
        if (key.channel === "stdout") {
          stdoutWrites += 1;
          if (index === 0) {
            stdoutStarted(true);
            await blocked;
          }
        } else {
          stderrStarted(true);
        }
      }
      await put(key, index, content, digest);
    };
    const output = "dependency resolved\n".repeat(10_000);
    const spawn = vi
      .fn()
      .mockResolvedValueOnce(process(1))
      .mockResolvedValueOnce(process(0, [output], [output]));
    let returned = false;
    const run = async () => {
      const result = await ensureCheckoutDependencies(input(spawn, store));
      returned = true;
      return result;
    };
    const running = run();
    await Promise.all([stdoutSeen, stderrSeen]);
    expect(returned).toBe(false);
    expect(stdoutWrites).toBe(1);
    release(true);
    const result = await running;
    const [, install] = result.attempts;
    if (install === undefined) {
      throw new Error("Missing install attempt");
    }
    expect(await readAll(store, install, "stdout")).toBe(output);
    expect(await readAll(store, install, "stderr")).toBe(output);
  });

  it("recovers a readable manifest after a lost publish acknowledgement", async () => {
    const { store } = memoryStore();
    const { publish } = store;
    store.publish = async (key, reference) => {
      await publish(key, reference);
      throw new Error("lost acknowledgement");
    };
    const spawn = vi
      .fn()
      .mockResolvedValueOnce(process(1))
      .mockResolvedValueOnce(process(0, ["restored\n"]));
    const result = await ensureCheckoutDependencies(input(spawn, store));
    const [, install] = result.attempts;
    if (install === undefined) {
      throw new Error("Missing install attempt");
    }
    expect(install.durability).toBe("available");
    expect(await readAll(store, install, "stdout")).toBe("restored\n");
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("reports unavailable durability when storage is absent or manifest publication fails", async () => {
    const { store } = memoryStore();
    store.publish = async () => {
      throw new Error("database unavailable");
    };
    for (const logStore of [undefined, store]) {
      const spawn = vi
        .fn()
        .mockResolvedValueOnce(process(1))
        .mockResolvedValueOnce(process(0, ["install succeeded\n"]));
      // oxlint-disable-next-line eslint/no-await-in-loop -- Exercise both independent unavailable storage modes.
      const result = await ensureCheckoutDependencies(input(spawn, logStore));
      expect(result.status).toBe("installed");
      expect(result.attempts[1]?.durability).toBe("unavailable");
      expect(result.attempts[1]?.logs).toEqual({});
      expect(result.attempts[1]?.excerpt).toBe("install succeeded");
      expect(spawn).toHaveBeenCalledTimes(2);
    }
  });
});
