"use client";

import { startTransition, useActionState, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { continueHandoffProvisioning } from "@/app/actions/builder";
import type {
  BuilderProvisionProjection,
  BuilderProvisionResponse,
} from "@/lib/provisioning/contracts";

function readProjection(value: unknown): BuilderProvisionProjection | undefined {
  if (!value || typeof value !== "object") return undefined;
  const projection = value as {
    revision?: unknown;
    provisioning?: BuilderProvisionResponse;
  };
  return typeof projection.revision === "number" &&
    Number.isSafeInteger(projection.revision) &&
    projection.revision > 0 &&
    projection.provisioning?.status
    ? (projection as BuilderProvisionProjection)
    : undefined;
}

/**
 * A deliberately narrow browser leaf: the server-rendered handoff owns the
 * durable state while this component consumes its revisioned SSE projection
 * and asks one Server Action to claim visible-route continuation work.
 */
export function HandoffProvisioningProgress({
  handoffId,
  initial,
}: {
  handoffId: string;
  initial: BuilderProvisionProjection;
}) {
  const router = useRouter();
  const [snapshot, setSnapshot] = useState(initial);
  const latestRevision = useRef(initial.revision);
  const settledRefresh = useRef(false);
  const dispatched = useRef(false);
  const [actionState, dispatch, pending] = useActionState(continueHandoffProvisioning, undefined);

  useEffect(() => {
    if (initial.revision <= latestRevision.current) return;
    latestRevision.current = initial.revision;
    setSnapshot(initial);
  }, [initial]);

  useEffect(() => {
    if (snapshot.provisioning.status !== "settled" || settledRefresh.current) return;
    settledRefresh.current = true;
    router.refresh();
  }, [router, snapshot.provisioning.status]);

  useEffect(() => {
    if (snapshot.provisioning.status === "settled" || dispatched.current) return;
    dispatched.current = true;
    startTransition(() => dispatch({ handoffId }));
  }, [dispatch, handoffId, snapshot.provisioning.status]);

  useEffect(() => {
    if (typeof EventSource === "undefined" || snapshot.provisioning.status === "settled") return;
    let closed = false;
    let source: EventSource | undefined;
    const connect = () => {
      if (closed || latestRevision.current <= 0) return;
      source = new EventSource(
        `/api/builder/provision/stream?requestId=${encodeURIComponent(
          snapshot.provisioning.requestId,
        )}`,
      );
      const receive = (event: MessageEvent<string>) => {
        try {
          const next = readProjection(JSON.parse(event.data));
          if (!next || next.revision <= latestRevision.current) return;
          latestRevision.current = next.revision;
          setSnapshot(next);
        } catch {
          // Malformed stream data never replaces the last authenticated state.
        }
      };
      source.addEventListener("snapshot", receive);
      source.addEventListener("end", receive);
      source.onerror = () => {
        if (closed) return;
        // Keep this EventSource alive: its native reconnect sends the most
        // recent SSE event id as Last-Event-ID. Replacing it here would lose
        // that cursor and turn a transient disconnect into a full replay.
      };
    };
    connect();
    return () => {
      closed = true;
      source?.close();
    };
  }, [snapshot.provisioning.requestId, snapshot.provisioning.status]);

  const failure = actionState?.status === "error" && !pending;
  const retry = () => {
    if (pending) return;
    startTransition(() => dispatch({ handoffId }));
  };
  return (
    <section aria-label="Provisioning progress">
      <p role="status" aria-live="polite">
        {snapshot.provisioning.status === "settled"
          ? "Provider setup is complete."
          : pending
            ? "Preparing your selected providers…"
            : failure
              ? "Provider setup paused. Your handoff is saved."
              : "Preparing your selected providers…"}
      </p>
      {failure ? (
        <button type="button" onClick={retry}>
          Retry provider setup
        </button>
      ) : null}
    </section>
  );
}
