/* oxlint-disable sonarjs/no-internal-api-use -- Tests use the actual installed Eve context to prove owner/session persistence; product code uses only public Eve state. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  ContextContainer,
  contextStorage,
} from "../../node_modules/eve/dist/src/context/container.js";
import {
  deserializeContext,
  serializeContext,
} from "../../node_modules/eve/dist/src/context/serialize.js";
import { validationLogStoreForSession } from "./validation-log-store-for-session";
import { ValidationLogWriter, readValidationLogPage } from "../repository/validation-log";
import getValidationLog from "../../agent/tools/get_validation_log";

// oxlint-disable-next-line anti-slop/no-module-mocking -- Expose the actual tool execute method without running the agent model.
vi.mock("eve/tools", () => ({ defineTool: <T>(value: T) => value }));
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map(async (root) => {
      await rm(root, { force: true, recursive: true });
    }),
  );
});
const localProfile = async () => {
  const stateRoot = await realpath(await mkdtemp(path.join(tmpdir(), "local-validation-log-")));
  roots.push(stateRoot);
  const runsRoot = path.join(stateRoot, "runs");
  await mkdir(runsRoot, { mode: 0o700 });
  for (const [name, value] of Object.entries({
    APP_BUILDER_DEV_RUNS_ROOT: runsRoot,
    APP_BUILDER_EXECUTION_BUNDLE: "local-development",
    APP_BUILDER_EXECUTION_MODE: "development",
    APP_BUILDER_LOCAL_ADAPTER: "1",
    APP_BUILDER_SANDBOX_PROVIDER: "vercel",
    DATABASE_URL: "",
    EVE_HOSTED_ADAPTER: "0",
  })) {
    vi.stubEnv(name, value);
  }
};
describe("actual developer validation log profile", () => {
  it("streams real redacted files and reads them through the public paging tool after an Eve boundary", async () => {
    await localProfile();
    const container = new ContextContainer();
    const writer = await contextStorage.run(container, async () => {
      const store = await validationLogStoreForSession({
        sessionAuth: null,
        sessionId: "actual-local-session",
      });
      const output = new ValidationLogWriter(store, {
        attemptDigest: "a".repeat(64),
        channel: "stdout",
        command: "check-build",
        sessionId: "actual-local-session",
      });
      await output.append(
        `apps/example: token=fixture-private-value\n${"Unicode progress π\n".repeat(5000)}`,
      );
      const { reference } = await output.finish("complete");
      expect(reference.chunkCount).toBeGreaterThan(1);
      return { key: output.key, reference };
    });
    const resumed = await deserializeContext(serializeContext(container));
    await contextStorage.run(resumed, async () => {
      const input = {
        attemptDigest: writer.key.attemptDigest,
        channel: writer.key.channel,
        command: "check-build" as const,
        digest: writer.reference.digest,
        logId: writer.key.logId,
      };
      // SAFETY: The identity tool fixture reads only this actual local session field.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The real paging tool reads only this supplied session field in the identity tool fixture.
      const context = { session: { auth: null, id: "actual-local-session" } } as never;
      const first = await getValidationLog.execute(input, context);
      if (!("content" in first)) {
        throw new Error("Expected a real log page.");
      }
      expect(first.content).toContain("[REDACTED]");
      expect(first.content).not.toContain("fixture-private-value");
      const store = await validationLogStoreForSession({
        sessionAuth: null,
        sessionId: "actual-local-session",
      });
      await expect(
        readValidationLogPage({
          cursor: "invalid:1",
          digest: writer.reference.digest,
          key: writer.key,
          store,
        }),
      ).rejects.toThrow();
      await expect(
        validationLogStoreForSession({ sessionAuth: null, sessionId: "different-session" }),
      ).rejects.toThrow();
      await expect(
        store.getReference({ ...writer.key, sessionId: "different-session" }),
      ).rejects.toThrow();
      await store.removeStaged(writer.key);
      expect(await store.getReference(writer.key)).toEqual(writer.reference);
    });
  });
  it("cannot publish a missing chunk or conflicting immutable log", async () => {
    await localProfile();
    await contextStorage.run(new ContextContainer(), async () => {
      const store = await validationLogStoreForSession({ sessionAuth: null, sessionId: "local" });
      const output = new ValidationLogWriter(store, {
        attemptDigest: "a".repeat(64),
        channel: "stderr",
        command: "test",
        sessionId: "local",
      });
      await expect(
        store.publish(output.key, {
          bytes: 1,
          channel: "stderr",
          chunkCount: 1,
          digest: "b".repeat(64),
          logId: output.key.logId,
        }),
      ).rejects.toThrow();
      expect(await store.getReference(output.key)).toBeUndefined();
      await output.append("failure detail\n");
      const { reference } = await output.finish("interrupted");
      await expect(
        store.publish(output.key, { ...reference, completion: "complete" }),
      ).rejects.toThrow();
    });
  });
});
