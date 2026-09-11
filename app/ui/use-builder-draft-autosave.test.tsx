/** @vitest-environment jsdom */

import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BuilderDraftOutbox } from "./builder-draft-outbox";
import {
  type BuilderDraftAutosave,
  useBuilderDraftAutosave,
} from "./use-builder-draft-autosave";

type Snapshot = { brief: string };

let root: Root | undefined;
let container: HTMLDivElement | undefined;
let autosave: BuilderDraftAutosave<Snapshot> | undefined;

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function Harness({
  outbox,
  save,
}: {
  outbox: BuilderDraftOutbox<Snapshot>;
  save: Parameters<typeof useBuilderDraftAutosave<Snapshot>>[0]["save"];
}) {
  const value = useBuilderDraftAutosave({ outbox, save, debounceMs: 10_000 });
  useEffect(() => {
    autosave = value;
  }, [value]);
  return null;
}

async function render(props: Parameters<typeof Harness>[0]) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(<Harness {...props} />));
  if (!autosave) throw new Error("autosave-harness-not-ready");
  return autosave;
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  autosave = undefined;
  vi.restoreAllMocks();
});

describe("useBuilderDraftAutosave", () => {
  it("waits for the newest queued checkpoint before a provider flush resolves", async () => {
    let resolveFirst: (() => void) | undefined;
    const firstSave = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const outbox: BuilderDraftOutbox<Snapshot> = {
      read: vi.fn(),
      write: vi.fn(),
      clear: vi.fn(),
      clearIfMutationId: vi.fn(async () => true),
    };
    const save = vi.fn(async ({ mutationId, snapshot }) => {
      if (snapshot.brief === "older") await firstSave;
      return {
        mutationId,
        revision: snapshot.brief === "older" ? 1 : 2,
        savedAt: "2030-01-01T00:00:00.000Z",
      };
    });
    const value = await render({ outbox, save });

    await act(async () => {
      value.schedule({ brief: "older" });
      const previousFlush = value.flush();
      expect(save).toHaveBeenCalledTimes(1);

      value.schedule({ brief: "newer" });
      const providerFlush = value.flush();
      resolveFirst?.();
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
    let entry:
      | import("./builder-draft-outbox").BuilderDraftOutboxEntry<Snapshot>
      | undefined;
    const outbox: BuilderDraftOutbox<Snapshot> = {
      read: vi.fn(async () => entry),
      write: vi.fn(async (next) => {
        entry = next;
      }),
      clear: vi.fn(),
      clearIfMutationId: vi.fn(async (mutationId) => {
        if (entry?.mutationId !== mutationId) return false;
        entry = undefined;
        return true;
      }),
      clearIfAcknowledged: vi.fn(async (acknowledgement) => {
        if (entry?.mutationId !== acknowledgement.mutationId) return false;
        entry = undefined;
        return true;
      }),
    };
    let releaseFirst: (() => void) | undefined;
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const save = vi.fn(async ({ mutationId, snapshot }) => {
      if (snapshot.brief === "first") await first;
      return { mutationId, revision: snapshot.brief === "first" ? 1 : 2 };
    });
    const value = await render({ outbox, save });

    await act(async () => {
      value.schedule({ brief: "first" });
      const flushing = value.flush();
      value.schedule({ brief: "second" });
      releaseFirst?.();
      await flushing;
    });

    expect(outbox.clearIfAcknowledged).toHaveBeenCalledTimes(2);
    expect(entry).toBeUndefined();
  });

  it("discards queued recovery work superseded by a remote revision", async () => {
    let entry:
      | import("./builder-draft-outbox").BuilderDraftOutboxEntry<Snapshot>
      | undefined;
    const outbox: BuilderDraftOutbox<Snapshot> = {
      read: vi.fn(async () => entry),
      write: vi.fn(async (next) => {
        entry = next;
      }),
      clear: vi.fn(),
      clearIfMutationId: vi.fn(async (mutationId) => {
        if (entry?.mutationId !== mutationId) return false;
        entry = undefined;
        return true;
      }),
    };
    const value = await render({
      outbox,
      save: vi.fn(),
    });

    await act(async () => {
      value.schedule({ brief: "local" });
    });
    await act(async () => {
      await expect(value.discardSupersededByRemoteRevision(1)).resolves.toBe(
        true,
      );
    });

    expect(outbox.clearIfMutationId).toHaveBeenCalledTimes(1);
    expect(entry).toBeUndefined();
  });
});
