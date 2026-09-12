"use client";

import { startTransition, useActionState, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import {
  continueHandoffProvisioning,
  type HandoffProvisioningContinuationState,
} from "@/app/actions/builder";
import {
  builderProvisionProjectionSchema,
  type BuilderProvisionProjection,
} from "@/lib/provisioning/contracts-schema";

function readProjection(value: unknown): BuilderProvisionProjection | undefined {
  const parsed = builderProvisionProjectionSchema.safeParse(value);
  return parsed.success && Number.isSafeInteger(parsed.data.revision) ? parsed.data : undefined;
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
  const [connection, setConnection] = useState<"connecting" | "connected" | "reconnecting">(
    "connecting",
  );
  const [streamAttempt, setStreamAttempt] = useState(0);
  const latestRevision = useRef(initial.revision);
  const settledRefresh = useRef(false);
  const dispatched = useRef(false);
  const [actionState, dispatch, pending] = useActionState(
    async (
      previous: HandoffProvisioningContinuationState | undefined,
      input: { handoffId: string },
    ): Promise<HandoffProvisioningContinuationState> => {
      try {
        return await continueHandoffProvisioning(previous, input);
      } catch {
        // Transport failures never discard the durable handoff or escape to
        // the route error boundary. Retrying claims the same journal safely.
        return { status: "error" };
      }
    },
    undefined,
  );

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
        )}&afterRevision=${latestRevision.current}`,
      );
      const receive = (event: MessageEvent<string>) => {
        if (closed) return;
        try {
          const next = readProjection(JSON.parse(event.data));
          if (
            !next ||
            next.provisioning.requestId !== snapshot.provisioning.requestId ||
            next.revision <= latestRevision.current
          )
            return;
          latestRevision.current = next.revision;
          setSnapshot(next);
        } catch {
          // Malformed stream data never replaces the last authenticated state.
        }
      };
      source.addEventListener("snapshot", receive);
      source.addEventListener("end", receive);
      source.addEventListener("open", () => {
        if (!closed) setConnection("connected");
      });
      source.addEventListener("error", () => {
        if (closed) return;
        setConnection("reconnecting");
        // Keep this EventSource alive: its native reconnect sends the most
        // recent SSE event id as Last-Event-ID. Replacing it here would lose
        // that cursor and turn a transient disconnect into a full replay.
      });
    };
    connect();
    return () => {
      closed = true;
      source?.close();
    };
  }, [snapshot.provisioning.requestId, snapshot.provisioning.status, streamAttempt]);

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
      {snapshot.provisioning.status !== "settled" && connection !== "connected" ? (
        <p role="status" aria-live="polite">
          {connection === "reconnecting"
            ? "Progress connection interrupted. Reconnecting… Your handoff is saved."
            : "Connecting to saved progress…"}
        </p>
      ) : null}
      {snapshot.provisioning.status !== "settled" && connection === "reconnecting" ? (
        <button
          type="button"
          onClick={() => {
            setConnection("connecting");
            setStreamAttempt((attempt) => attempt + 1);
          }}
        >
          Reconnect progress
        </button>
      ) : null}
      {failure ? (
        <button type="button" onClick={retry}>
          Retry provider setup
        </button>
      ) : null}
    </section>
  );
}
