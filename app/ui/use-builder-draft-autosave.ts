"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type {
  BuilderDraftOutbox,
  BuilderDraftOutboxEntry,
} from "./builder-draft-outbox";

export type BuilderDraftAutosaveStatus =
  "idle" | "saving" | "saved" | "offline" | "error";

export type BuilderDraftAutosaveReason =
  "debounce" | "flush" | "visibilitychange" | "pagehide";

export type BuilderDraftSaveContext<T> = {
  mutationId: string;
  snapshot: T;
  reason: BuilderDraftAutosaveReason;
  /** True when the caller may use fetch keepalive/beacon semantics. */
  keepalive: boolean;
};

export type BuilderDraftSaveAcknowledgement = {
  /** Must exactly match the dispatched mutation ID before the outbox is cleared. */
  mutationId: string;
  /** The monotonic server revision that acknowledged this exact snapshot. */
  revision: number;
  savedAt?: string;
};

export type BuilderDraftAutosaveOptions<T> = {
  outbox: BuilderDraftOutbox<T>;
  save: (context: BuilderDraftSaveContext<T>) => Promise<BuilderDraftSaveAcknowledgement>;
  debounceMs?: number;
  /** Revision used as the base for snapshots queued immediately after mount. */
  initialRevision?: number;
  /** Defaults to navigator.onLine when available. */
  isOnline?: () => boolean;
  /** Called after a hidden/pagehide flush is requested, for transport telemetry. */
  onVisibilityFlush?: (reason: "visibilitychange" | "pagehide") => void;
  /** Acknowledgements advance local revision knowledge but never reset the form. */
  onAcknowledged?(acknowledgement: BuilderDraftSaveAcknowledgement): void;
};

export type BuilderDraftAutosave<T> = {
  status: BuilderDraftAutosaveStatus;
  error: Error | undefined;
  lastSavedAt: string | undefined;
  schedule: (snapshot: T) => string;
  flush: (reason?: Exclude<BuilderDraftAutosaveReason, "debounce">) => Promise<void>;
  retry: () => Promise<void>;
  /** Reads the recovery snapshot without dispatching it. */
  restorePending: () => Promise<BuilderDraftOutboxEntry<T> | undefined>;
  /** Reads, queues, and sends a recovery snapshot. */
  resumePending: () => Promise<void>;
  /** Discards local work that a newer server revision has superseded. */
  discardPending: () => Promise<void>;
  /**
   * Drops queued/outbox work based on an older revision before the owner resets
   * its form to newer server state. A mutation already in flight is allowed to
   * settle; the next poll remains authoritative.
   */
  discardSupersededByRemoteRevision(revision: number): Promise<boolean>;
  /** Drops queued work superseded by a newer remote revision. */
  discardSupersededByRemoteRevision: (revision: number) => Promise<boolean>;
};

type Pending<T> = BuilderDraftOutboxEntry<T>;

function createMutationId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function")
    return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function cloneSnapshot<T>(snapshot: T): T {
  return structuredClone(snapshot);
}

function browserIsOnline() {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

/**
 * Serializes saves, retains the newest unacknowledged snapshot in the supplied
 * outbox, and never installs a beforeunload warning. Call `flush` before a
 * provider redirect; browser hiding automatically makes a best-effort flush.
 */
export function useBuilderDraftAutosave<T>(
  options: BuilderDraftAutosaveOptions<T>,
): BuilderDraftAutosave<T> {
  const [status, setStatus] = useState<BuilderDraftAutosaveStatus>("idle");
  const [error, setError] = useState<Error>();
  const [lastSavedAt, setLastSavedAt] = useState<string>();
  const queued = useRef<Pending<T> | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const draining = useRef<Promise<boolean> | undefined>(undefined);
  const acknowledgedRevision = useRef(options.initialRevision ?? 0);
  const mounted = useRef(true);
  const save = useRef(options.save);
  const isOnline = useRef(options.isOnline);
  const onVisibilityFlush = useRef(options.onVisibilityFlush);
  const onAcknowledged = useRef(options.onAcknowledged);

  useEffect(() => {
    save.current = options.save;
    isOnline.current = options.isOnline;
    onVisibilityFlush.current = options.onVisibilityFlush;
    onAcknowledged.current = options.onAcknowledged;
  }, [
    options.isOnline,
    options.onAcknowledged,
    options.onVisibilityFlush,
    options.save,
  ]);

  const updateStatus = useCallback(
    (next: BuilderDraftAutosaveStatus, nextError?: Error) => {
      if (!mounted.current) return;
      setStatus(next);
      setError(nextError);
    },
    [],
  );

  const online = useCallback(() => {
    const check = isOnline.current ?? browserIsOnline;
    return check();
  }, []);

  const dispatch = useCallback(
    async (reason: BuilderDraftAutosaveReason) => {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = undefined;
      }

      if (draining.current) return draining.current;
      const run = async () => {
        while (queued.current) {
          if (!online()) {
            updateStatus("offline");
            return false;
          }

          const {current} = queued;
          queued.current = undefined;
          updateStatus("saving");
          try {
            const acknowledgement = await save.current({
              mutationId: current.mutationId,
              snapshot: current.snapshot,
              reason,
              keepalive: reason === "visibilitychange" || reason === "pagehide",
            });
            if (acknowledgement.mutationId !== current.mutationId)
              throw new Error("builder-draft-acknowledgement-mismatch");
            acknowledgedRevision.current = Math.max(
              acknowledgedRevision.current,
              acknowledgement.revision,
            );
            if (options.outbox.clearIfAcknowledged)
              await options.outbox.clearIfAcknowledged({
                mutationId: current.mutationId,
                revision: acknowledgement.revision,
              });
            else await options.outbox.clearIfMutationId(current.mutationId);
            onAcknowledged.current?.(acknowledgement);
            if (mounted.current) setLastSavedAt(acknowledgement.savedAt);
          } catch (caught) {
            if (!queued.current) queued.current = current;
            updateStatus(
              online() ? "error" : "offline",
              caught instanceof Error
                ? caught
                : new Error("builder-draft-save-failed"),
            );
            return false;
          }
        }
        updateStatus("saved");
        return true;
      };
      const pending = run();
      draining.current = pending;
      try {
        await pending;
      } finally {
        if (draining.current === pending) draining.current = undefined;
      }
    },
    [online, options.outbox, updateStatus],
  );

  const flush = useCallback(
    async (
      reason: Exclude<BuilderDraftAutosaveReason, "debounce"> = "flush",
    ) => {
      // A newer snapshot can be queued in the narrow window while an older
      // dispatch is completing. In particular, provider redirects must not
      // continue until that newer snapshot has received its own acknowledgement.
      do {
        const drained = await dispatch(reason);
        // An offline/error result deliberately retains the outbox entry for a
        // later retry. Do not spin indefinitely while the save is unavailable.
        if (!drained) return;
      } while (queued.current);
    },
    [dispatch],
  );

  const schedule = useCallback(
    (snapshot: T) => {
      const entry: Pending<T> = {
        version: 1,
        baseRevision: acknowledgedRevision.current,
        mutationId: createMutationId(),
        snapshot: cloneSnapshot(snapshot),
        createdAt: Date.now(),
      };
      queued.current = entry;
      void options.outbox.write(entry);
      updateStatus(online() ? "saving" : "offline");
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = undefined;
        void dispatch("debounce");
      }, options.debounceMs ?? 500);
      return entry.mutationId;
    },
    [dispatch, online, options.debounceMs, options.outbox, updateStatus],
  );

  const restorePending = useCallback(
    () => options.outbox.read(),
    [options.outbox],
  );

  const resumePending = useCallback(async () => {
    const entry = await options.outbox.read();
    if (!mounted.current || !entry || queued.current) return;
    queued.current = entry;
    updateStatus(online() ? "saving" : "offline");
    await flush("flush");
  }, [flush, online, options.outbox, updateStatus]);

  const retry = useCallback(() => flush("flush"), [flush]);

  const discardPending = useCallback(async () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = undefined;
    }
    queued.current = undefined;
    await options.outbox.clear();
    updateStatus("saved");
  }, [options.outbox, updateStatus]);

  const discardSupersededByRemoteRevision = useCallback(
    async (revision: number) => {
      if (
        !Number.isSafeInteger(revision) ||
        revision <= acknowledgedRevision.current
      )
        return false;
      acknowledgedRevision.current = revision;
      if (
        queued.current &&
        (queued.current.baseRevision ?? 0) < revision
      )
        queued.current = undefined;
      const pending = await options.outbox.read();
      if (pending && (pending.baseRevision ?? 0) < revision)
        await options.outbox.clearIfMutationId(pending.mutationId);
      updateStatus("saved");
      return true;
    },
    [options.outbox, updateStatus],
  );

  useEffect(() => {
    const retryWhenOnline = () => void flush("flush");
    window.addEventListener("online", retryWhenOnline);
    return () => window.removeEventListener("online", retryWhenOnline);
  }, [flush]);

  useEffect(() => {
    const visibility = () => {
      if (document.visibilityState !== "hidden") return;
      onVisibilityFlush.current?.("visibilitychange");
      void flush("visibilitychange");
    };
    const pagehide = () => {
      onVisibilityFlush.current?.("pagehide");
      void flush("pagehide");
    };
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("pagehide", pagehide);
    return () => {
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("pagehide", pagehide);
    };
  }, [flush]);

  useEffect(
    () => () => {
      mounted.current = false;
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  return {
    status,
    error,
    lastSavedAt,
    schedule,
    flush,
    retry,
    restorePending,
    resumePending,
    discardPending,
    discardSupersededByRemoteRevision,
  };
}
