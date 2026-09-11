/** @vitest-environment jsdom */

import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BuilderDraftOutbox } from "./builder-draft-outbox";
import { useBuilderDraftAutosave } from "./use-builder-draft-autosave";
import type { BuilderDraftAutosave } from "./use-builder-draft-autosave";

interface Snapshot {
  brief: string;
}

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
  const value = useBuilderDraftAutosave({ debounceMs: 10_000, outbox, save });
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
  if (!autosave) {
    throw new Error("autosave-harness-not-ready");
  }
  return autosave;
}

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
  }
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
      clear: vi.fn(),
      clearIfMutationId: vi.fn(async () => true),
      read: vi.fn(),
      write: vi.fn(),
    };
    const save = vi.fn(async ({ mutationId, snapshot }) => {
      if (snapshot.brief === "older") {
        await firstSave;
      }
      return { mutationId, savedAt: "2030-01-01T00:00:00.000Z" };
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
      expect.objectContaining({ snapshot: { brief: "older" } })
    );
    expect(save).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ snapshot: { brief: "newer" } })
    );
    expect(outbox.clearIfMutationId).toHaveBeenCalledTimes(2);
  });
});
