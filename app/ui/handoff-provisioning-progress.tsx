"use client";

import { startTransition, useActionState, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { continueHandoffProvisioning } from "@/app/actions/builder";
import type { HandoffProvisioningContinuationState } from "@/app/actions/builder";
import { builderProvisionProjectionSchema } from "@/lib/provisioning/contracts-schema";
import type { BuilderProvisionProjection } from "@/lib/provisioning/contracts-schema";

/**
 * A deliberately narrow browser leaf: the server-rendered handoff owns the
 * durable state while this component consumes its revisioned SSE projection
 * and asks one Server Action to claim visible-route continuation work.
 */
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function HandoffProvisioningProgress({
  handoffId,
  initial,
}: {
  handoffId: string;
  initial: BuilderProvisionProjection;
}) {
  const router = useRouter();
  const [streamProjection, setStreamProjection] = useState<BuilderProvisionProjection>();
  const snapshot =
    streamProjection && streamProjection.revision > initial.revision ? streamProjection : initial;
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
  );

  useEffect(() => {
    latestRevision.current = Math.max(latestRevision.current, initial.revision);
  }, [initial.revision]);

  useEffect(() => {
    if (snapshot.provisioning.status !== "settled" || settledRefresh.current) {
      return;
    }
    settledRefresh.current = true;
    router.refresh();
  }, [router, snapshot.provisioning.status]);

  useEffect(() => {
    if (snapshot.provisioning.status === "settled" || dispatched.current) {
      return;
    }
    dispatched.current = true;
    startTransition(() => {
      dispatch({ handoffId });
    });
  }, [dispatch, handoffId, snapshot.provisioning.status]);

  useEffect(() => {
    let closed = false;
    if (typeof EventSource === "undefined" || snapshot.provisioning.status === "settled") {
      return () => {
        closed = true;
      };
    }
    const source = new EventSource(
      `/api/builder/provision/stream?requestId=${encodeURIComponent(
        snapshot.provisioning.requestId,
      )}&afterRevision=${latestRevision.current}`,
    );
    const receive = (event: MessageEvent<string>) => {
      if (closed) {
        return;
      }
      try {
        const parsed = builderProvisionProjectionSchema.safeParse(JSON.parse(event.data));
        const next =
          parsed.success && Number.isSafeInteger(parsed.data.revision) ? parsed.data : undefined;
        if (
          !next ||
          next.provisioning.requestId !== snapshot.provisioning.requestId ||
          next.revision <= latestRevision.current
        ) {
          return;
        }
        latestRevision.current = next.revision;
        setStreamProjection(next);
      } catch {
        // Malformed stream data never replaces the last authenticated state.
      }
    };
    const opened = () => {
      if (!closed) {
        setConnection("connected");
      }
    };
    const errored = () => {
      if (!closed) {
        setConnection("reconnecting");
        // Keep this EventSource alive: its native reconnect sends the most
        // recent SSE event id as Last-Event-ID. Replacing it here would lose
        // that cursor and turn a transient disconnect into a full replay.
      }
    };
    source.addEventListener("snapshot", receive);
    source.addEventListener("end", receive);
    source.addEventListener("open", opened);
    source.addEventListener("error", errored);
    return () => {
      closed = true;
      source.removeEventListener("snapshot", receive);
      source.removeEventListener("end", receive);
      source.removeEventListener("open", opened);
      source.removeEventListener("error", errored);
      source.close();
    };
  }, [snapshot.provisioning.requestId, snapshot.provisioning.status, streamAttempt]);

  const failure = actionState?.status === "error" && !pending;
  let progressMessage = "Preparing your selected providers…";
  if (snapshot.provisioning.status === "settled") {
    progressMessage = "Provider setup is complete.";
  } else if (failure) {
    progressMessage = "Provider setup paused. Your handoff is saved.";
  }
  const retry = () => {
    if (pending) {
      return;
    }
    startTransition(() => {
      dispatch({ handoffId });
    });
  };
  return (
    <section aria-label="Provisioning progress">
      <p role="status" aria-live="polite">
        {progressMessage}
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
