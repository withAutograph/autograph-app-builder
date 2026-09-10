"use client";

import { useEffect } from "react";

import type { BuilderProvisionResponse } from "@/lib/provisioning/contracts";

export function ProvisioningProgress({
  requestId,
  onSnapshot,
  onSettled,
}: {
  requestId: string;
  onSnapshot: (value: BuilderProvisionResponse) => void;
  onSettled: (value: BuilderProvisionResponse) => void;
}) {
  useEffect(() => {
    if (typeof EventSource === "undefined") return;
    const source = new EventSource(
      `/api/builder/provision/stream?requestId=${encodeURIComponent(requestId)}`,
    );
    const receive = (event: MessageEvent<string>) => {
      try {
        const value = JSON.parse(event.data) as BuilderProvisionResponse;
        onSnapshot(value);
        if (value.status === "settled") onSettled(value);
      } catch {
        // A malformed event must not replace the last durable snapshot.
      }
    };
    source.addEventListener("snapshot", receive);
    source.addEventListener("end", receive);
    return () => source.close();
  }, [onSettled, onSnapshot, requestId]);

  return null;
}
