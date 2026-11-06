// @vitest-environment jsdom

import { act, StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BuilderDraftOutbox, BuilderDraftOutboxEntry } from "./builder-draft-outbox";
import { useBuilderDraftAutosave } from "./use-builder-draft-autosave";
import type {
  BuilderDraftAutosave,
  BuilderDraftSaveAcknowledgement,
  BuilderDraftSaveContext,
} from "./use-builder-draft-autosave";

interface Snapshot {
  brief: string;
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let autosave: BuilderDraftAutosave<Snapshot> | null = null;

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function harness({
  outbox,
  save,
  onAcknowledged,
}: {
  outbox: BuilderDraftOutbox<Snapshot>;
  save: Parameters<typeof useBuilderDraftAutosave<Snapshot>>[0]["save"];
  onAcknowledged?: Parameters<typeof useBuilderDraftAutosave<Snapshot>>[0]["onAcknowledged"];
}) {
  const value = useBuilderDraftAutosave({ debounceMs: 10_000, onAcknowledged, outbox, save });
  useEffect(() => {
    autosave = value;
  }, [value]);
  return null;
}

const AutosaveHarness = (props: Parameters<typeof harness>[0]) => <>{harness(props)}</>;

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
async function render(props: Parameters<typeof harness>[0], strict = false) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
  await act(async () =>
    root?.render(
      strict ? (
        <StrictMode>
          <AutosaveHarness {...props} />
        </StrictMode>
      ) : (
        <AutosaveHarness {...props} />
      ),
    ),
  );
  if (!autosave) {
    throw new Error("autosave-harness-not-ready");
  }
  return autosave;
}

afterEach(async () => {
  if (root) {
    await act(async () => {
      root?.unmount();
      await Promise.resolve();
    });
  }
  container?.remove();
  root = null;
  container = null;
  autosave = null;
  vi.restoreAllMocks();
});

describe("useBuilderDraftAutosave", () => {
  it("drains a snapshot queued after the save loop completes but before flush resumes", async () => {
    const outbox: BuilderDraftOutbox<Snapshot> = {
      clear: vi.fn(),
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      clearIfMutationId: vi.fn(async () => true),
      read: vi.fn(),
      write: vi.fn(),
    };
    const save = vi.fn(
      async ({
        mutationId,
        snapshot,
      }: BuilderDraftSaveContext<Snapshot>): Promise<BuilderDraftSaveAcknowledgement> =>
        await Promise.resolve({
          mutationId,
          revision: snapshot.brief === "first" ? 1 : 2,
        }),
    );
    const value = await render({
      onAcknowledged: ({ revision }) => {
        if (revision === 1) {
          queueMicrotask(() => {
            autosave?.schedule({ brief: "completion-window" });
          });
        }
      },
      outbox,
      save,
    });
    await act(async () => {
      value.schedule({ brief: "first" });
      await value.flush();
      expect(save).toHaveBeenCalledTimes(2);
    });
    expect(save).toHaveBeenLastCalledWith(
      expect.objectContaining({ snapshot: { brief: "completion-window" } }),
    );
  });

  it("restores pending recovery and reports acknowledgements after StrictMode effect replay", async () => {
    const entry = {
      baseRevision: 0,
      createdAt: 1,
      mutationId: "recovered",
      snapshot: { brief: "recovered" },
      version: 1 as const,
    };
    const outbox: BuilderDraftOutbox<Snapshot> = {
      clear: vi.fn(),
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      clearIfMutationId: vi.fn(async () => await Promise.resolve(true)),
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      read: vi.fn(async () => entry),
      write: vi.fn(),
    };
    const save = vi.fn(
      async ({
        mutationId,
      }: BuilderDraftSaveContext<Snapshot>): Promise<BuilderDraftSaveAcknowledgement> =>
        await Promise.resolve({
          mutationId,
          revision: 1,
          savedAt: "2030-01-01T00:00:00.000Z",
        }),
    );
    const value = await render({ outbox, save }, true);
    await act(async () => {
      await value.resumePending();
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(autosave?.status).toBe("saved");
    expect(autosave?.lastSavedAt).toBe("2030-01-01T00:00:00.000Z");
  });

  it("waits for the newest queued checkpoint before a provider flush resolves", async () => {
    const { promise: firstSave, resolve: resolveFirst } = Promise.withResolvers<null>();
    const outbox: BuilderDraftOutbox<Snapshot> = {
      clear: vi.fn(),
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      clearIfMutationId: vi.fn(async () => true),
      read: vi.fn(),
      write: vi.fn(),
    };
    const save = vi.fn(
      async ({
        mutationId,
        snapshot,
      }: BuilderDraftSaveContext<Snapshot>): Promise<BuilderDraftSaveAcknowledgement> => {
        if (snapshot.brief === "older") {
          await firstSave;
        }
        return {
          mutationId,
          revision: snapshot.brief === "older" ? 1 : 2,
          savedAt: "2030-01-01T00:00:00.000Z",
        };
      },
    );
    const value = await render({ outbox, save });

    await act(async () => {
      value.schedule({ brief: "older" });
      const previousFlush = value.flush();
      expect(save).toHaveBeenCalledTimes(1);

      value.schedule({ brief: "newer" });
      const providerFlush = value.flush();
      resolveFirst(null);
      await Promise.all([previousFlush, providerFlush]);
    });

    expect(save).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ snapshot: { brief: "older" } }),
    );
    expect(save).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ snapshot: { brief: "newer" } }),
    );
    expect(outbox.clearIfMutationId).toHaveBeenCalledTimes(2);
  });

  it("clears only the exact acknowledged outbox snapshot", async () => {
    let entry: BuilderDraftOutboxEntry<Snapshot> | null = null;
    const outbox: BuilderDraftOutbox<Snapshot> = {
      clear: vi.fn(),
      clearIfAcknowledged: vi.fn(
        async (acknowledgement: { mutationId: string; revision: number }) => {
          if (entry?.mutationId !== acknowledgement.mutationId) {
            return await Promise.resolve(false);
          }
          entry = null;
          return await Promise.resolve(true);
        },
      ),
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      clearIfMutationId: vi.fn(async (mutationId) => {
        if (entry?.mutationId !== mutationId) {
          return false;
        }
        entry = null;
        return true;
      }),
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      read: vi.fn(async () => entry),
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      write: vi.fn(async (next: BuilderDraftOutboxEntry<Snapshot>) => {
        entry = next;
      }),
    };
    const { promise: first, resolve: releaseFirst } = Promise.withResolvers<null>();
    const save = vi.fn(
      async ({
        mutationId,
        snapshot,
      }: BuilderDraftSaveContext<Snapshot>): Promise<BuilderDraftSaveAcknowledgement> => {
        if (snapshot.brief === "first") {
          await first;
        }
        return { mutationId, revision: snapshot.brief === "first" ? 1 : 2 };
      },
    );
    const value = await render({ outbox, save });

    await act(async () => {
      value.schedule({ brief: "first" });
      const flushing = value.flush();
      value.schedule({ brief: "second" });
      releaseFirst(null);
      await flushing;
    });

    expect(outbox.clearIfAcknowledged).toHaveBeenCalledTimes(2);
    expect(entry).toBeUndefined();
  });

  it("discards queued recovery work superseded by a remote revision", async () => {
    let entry: BuilderDraftOutboxEntry<Snapshot> | null = null;
    const outbox: BuilderDraftOutbox<Snapshot> = {
      clear: vi.fn(),
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      clearIfMutationId: vi.fn(async (mutationId) => {
        if (entry?.mutationId !== mutationId) {
          return false;
        }
        entry = null;
        return true;
      }),
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      read: vi.fn(async () => entry),
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      write: vi.fn(async (next: BuilderDraftOutboxEntry<Snapshot>) => {
        entry = next;
      }),
    };
    const value = await render({
      outbox,
      save: vi.fn(),
    });

    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    await act(async () => {
      value.schedule({ brief: "local" });
    });
    await act(async () => {
      await expect(value.discardSupersededByRemoteRevision(1)).resolves.toBe(true);
    });

    expect(outbox.clearIfMutationId).toHaveBeenCalledTimes(1);
    expect(entry).toBeUndefined();
  });
});
