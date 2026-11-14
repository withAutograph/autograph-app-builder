"use client";

import { useEffect, useState } from "react";
import { z } from "zod";
import { deliveryProgressSchema } from "@/lib/delivery-progress";
import type { DeliveryProgress } from "@/lib/delivery-progress";
import { ProductionDeliveryProgress } from "@/components/create-app/production-delivery-progress";

const responseSchema = z.object({
  cursor: z.number().int().nonnegative(),
  delivery: deliveryProgressSchema.optional(),
  working: z.boolean(),
});

// oxlint-disable-next-line sonarjs/function-name -- React component names are capitalized.
export const BuilderDeliveryStatus = ({
  sessionId,
  showAppLink,
}: {
  sessionId: string;
  showAppLink: boolean;
}) => {
  const [progress, setProgress] = useState<DeliveryProgress>();
  // oxlint-disable-next-line react-doctor/effect-needs-cleanup -- Each deferred read is cleared in effect cleanup.
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reading = false;
    let working = false;
    let cursor = 0;
    let retryInitialRead = true;
    const read = async () => {
      if (document.visibilityState === "hidden" || reading || controller.signal.aborted) {
        return;
      }
      clearTimeout(timer);
      reading = true;
      let readFailed = false;
      try {
        const response = await fetch(
          `/api/builder/sessions/${encodeURIComponent(sessionId)}/delivery?after=${cursor}`,
          { cache: "no-store", signal: controller.signal },
        );
        if (controller.signal.aborted) {
          return;
        }
        if (!response.ok) {
          readFailed = response.status >= 500;
          if (response.status === 404) {
            working = false;
            setProgress(undefined);
          }
          return;
        }
        const next = responseSchema.safeParse(await response.json());
        if (!next.success || controller.signal.aborted) {
          return;
        }
        if (next.data.delivery !== undefined) {
          setProgress(next.data.delivery);
        }
        ({ cursor, working } = next.data);
        retryInitialRead = false;
      } catch {
        // Keep the latest confirmed status until an authenticated read succeeds.
        readFailed = true;
      } finally {
        reading = false;
        const retry = working || (readFailed && retryInitialRead);
        if (readFailed) {
          retryInitialRead = false;
        }
        if (retry && !controller.signal.aborted) {
          // Delay until the current read finishes to avoid overlapping requests.
          timer = setTimeout(() => {
            void read();
          }, 15_000);
        }
      }
    };
    const checkVisible = () => {
      void read();
    };
    checkVisible();
    document.addEventListener("visibilitychange", checkVisible);
    return () => {
      controller.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", checkVisible);
    };
  }, [sessionId]);
  return progress === undefined ? null : (
    <ProductionDeliveryProgress progress={progress} showAppLink={showAppLink} />
  );
};
