import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createApplicationReviewSandboxReader } from "./application-review-sandbox-reader";
import type { ApplicationReviewSandboxReaderDependencies } from "./application-review-sandbox-reader";

type Lookup = NonNullable<ApplicationReviewSandboxReaderDependencies["get"]>;
type Session = ReturnType<Awaited<ReturnType<Lookup>>["currentSession"]>;

const fixture = () => {
  let owned = true;
  const assertCurrentOwner = vi.fn(async () => {
    await Promise.resolve();
    if (!owned) {
      throw new Error("owner revoked");
    }
  });
  const readFile = vi.fn<Session["readFile"]>(() => Promise.resolve(null));
  const currentSession = vi.fn(() => ({ readFile }));
  const get = vi.fn<Lookup>(() => Promise.resolve({ currentSession }));
  return {
    assertCurrentOwner,
    currentSession,
    get,
    readFile,
    revoke: () => {
      owned = false;
    },
  };
};
const input = (state: ReturnType<typeof fixture>, abortSignal?: AbortSignal) => ({
  sandboxName: "server-owned-review-source",
  assertCurrentOwner: state.assertCurrentOwner,
  abortSignal,
});
const bytes = async (stream: ReadableStream<Uint8Array> | null) => {
  if (stream === null) {
    throw new Error("expected source stream");
  }
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
};

describe("read-only application review Sandbox reconstruction", () => {
  it("looks up the captured name without resume and streams exact bytes through the existing session", async () => {
    const state = fixture();
    const controller = new AbortController();
    const expected = Buffer.from([0, 255, 10, 195, 169]);
    state.readFile.mockResolvedValue(
      Readable.from([expected.subarray(0, 2), expected.subarray(2)]),
    );
    const reader = await createApplicationReviewSandboxReader(
      input(state, controller.signal),
      state,
    );
    const stream = await reader.readFile({ path: "repository/new-directory/source.ts" });
    expect(await bytes(stream)).toEqual(expected);
    expect(state.get).toHaveBeenCalledWith({
      name: "server-owned-review-source",
      resume: false,
      signal: controller.signal,
    });
    expect(state.readFile).toHaveBeenCalledWith(
      { path: "/workspace/repository/new-directory/source.ts" },
      { signal: controller.signal },
    );
  });

  it("preserves absolute source paths and missing-file results", async () => {
    const state = fixture();
    const reader = await createApplicationReviewSandboxReader(input(state), state);
    expect(await reader.readFile({ path: "/workspace/repository/missing.ts" })).toBeNull();
    expect(state.readFile).toHaveBeenCalledWith(
      { path: "/workspace/repository/missing.ts" },
      { signal: undefined },
    );
  });

  it("does not retry lookup or reconstruct an absent current session", async () => {
    const state = fixture();
    const absent = new Error("No active session");
    state.currentSession.mockImplementation(() => {
      throw absent;
    });
    await expect(createApplicationReviewSandboxReader(input(state), state)).rejects.toBe(absent);
    expect(state.get).toHaveBeenCalledOnce();
    expect(state.readFile).not.toHaveBeenCalled();
  });

  it("propagates lookup failures without another lookup", async () => {
    const state = fixture();
    const failure = new Error("provider lookup failed");
    state.get.mockRejectedValue(failure);
    await expect(createApplicationReviewSandboxReader(input(state), state)).rejects.toBe(failure);
    expect(state.get).toHaveBeenCalledOnce();
  });

  it("propagates a stopped session read without resume or a replacement lookup", async () => {
    const state = fixture();
    const stopped = new Error("sandbox stopped");
    state.readFile.mockRejectedValue(stopped);
    const reader = await createApplicationReviewSandboxReader(input(state), state);
    await expect(reader.readFile({ path: "repository/source.ts" })).rejects.toBe(stopped);
    expect(state.get).toHaveBeenCalledOnce();
    expect(state.readFile).toHaveBeenCalledOnce();
  });

  it("denies revoked ownership before lookup", async () => {
    const state = fixture();
    state.revoke();
    await expect(createApplicationReviewSandboxReader(input(state), state)).rejects.toThrow(
      "owner revoked",
    );
    expect(state.get).not.toHaveBeenCalled();
  });

  it("rechecks ownership after lookup and before resolving its session", async () => {
    const state = fixture();
    state.get.mockImplementation(() => {
      state.revoke();
      return Promise.resolve({ currentSession: state.currentSession });
    });
    await expect(createApplicationReviewSandboxReader(input(state), state)).rejects.toThrow(
      "owner revoked",
    );
    expect(state.currentSession).not.toHaveBeenCalled();
  });

  it("rechecks current ownership before each subsequent read", async () => {
    const state = fixture();
    const reader = await createApplicationReviewSandboxReader(input(state), state);
    await reader.readFile({ path: "repository/first.ts" });
    state.revoke();
    await expect(reader.readFile({ path: "repository/second.ts" })).rejects.toThrow(
      "owner revoked",
    );
    expect(state.readFile).toHaveBeenCalledOnce();
  });

  it("closes a returned local stream if ownership is revoked during the read", async () => {
    const state = fixture();
    const source = Readable.from([Buffer.from("private source")]);
    const destroyed = vi.spyOn(source, "destroy");
    state.readFile.mockImplementation(() => {
      state.revoke();
      return Promise.resolve(source);
    });
    const reader = await createApplicationReviewSandboxReader(input(state), state);
    await expect(reader.readFile({ path: "repository/source.ts" })).rejects.toThrow(
      "owner revoked",
    );
    expect(destroyed).toHaveBeenCalled();
  });

  it("stops before lookup if the parent is already cancelled", async () => {
    const state = fixture();
    const controller = new AbortController();
    const reason = new Error("parent Stop");
    controller.abort(reason);
    await expect(
      createApplicationReviewSandboxReader(input(state, controller.signal), state),
    ).rejects.toBe(reason);
    expect(state.get).not.toHaveBeenCalled();
  });

  it("checks cancellation after lookup", async () => {
    const state = fixture();
    const controller = new AbortController();
    const reason = new Error("Stop during lookup");
    state.get.mockImplementation(() => {
      controller.abort(reason);
      return Promise.resolve({ currentSession: state.currentSession });
    });
    await expect(
      createApplicationReviewSandboxReader(input(state, controller.signal), state),
    ).rejects.toBe(reason);
    expect(state.currentSession).not.toHaveBeenCalled();
  });

  it("combines parent and individual read cancellation and closes a cancelled read", async () => {
    const state = fixture();
    const parent = new AbortController();
    const request = new AbortController();
    const reason = new Error("read cancelled");
    const source = Readable.from([Buffer.from("source")]);
    const destroyed = vi.spyOn(source, "destroy");
    state.readFile.mockImplementation((_file, options) => {
      expect(options?.signal?.aborted).toBe(false);
      request.abort(reason);
      expect(options?.signal?.aborted).toBe(true);
      return Promise.resolve(source);
    });
    const reader = await createApplicationReviewSandboxReader(input(state, parent.signal), state);
    await expect(
      reader.readFile({ path: "repository/source.ts", abortSignal: request.signal }),
    ).rejects.toBe(reason);
    expect(parent.signal.aborted).toBe(false);
    expect(destroyed).toHaveBeenCalled();
  });

  it("preserves failures from a byte stream after opening", async () => {
    const state = fixture();
    const failure = new Error("source stream failed");
    state.readFile.mockResolvedValue(
      new Readable({
        read() {
          this.destroy(failure);
        },
      }),
    );
    const reader = await createApplicationReviewSandboxReader(input(state), state);
    await expect(bytes(await reader.readFile({ path: "repository/source.ts" }))).rejects.toBe(
      failure,
    );
  });
});
