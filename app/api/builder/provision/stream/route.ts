import { getBuilderProvisioningDeploymentHandler } from "@/lib/provisioning/deployment";
import { builderProvisionProjectionSchema } from "@/lib/provisioning/contracts";
import type { BuilderProvisionProjection } from "@/lib/provisioning/contracts";

const encoder = new TextEncoder();
const pollIntervalMs = 250;
const maxStreamMs = 30_000;
const heartbeatIntervalMs = 10_000;

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function event(data: unknown, id: string, name = "snapshot") {
  return encoder.encode(`id: ${id}\nevent: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function heartbeat() {
  return encoder.encode(": keep-alive\n\n");
}

/**
 * Stream the durable provisioning journal to the browser. The journal remains
 * the source of truth; SSE only provides a low-latency projection of its
 * revisions and therefore survives reconnects through the normal GET route.
 */
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export async function GET(request: Request) {
  const source = new URL(request.url);
  const requestId = source.searchParams.get("requestId");
  if (!requestId) return Response.json({ error: "request_invalid" }, { status: 400 });

  const handler = getBuilderProvisioningDeploymentHandler(process.env);
  const headers = new Headers(request.headers);
  headers.set("accept", "application/json");
  const read = () =>
    handler(
      new Request(
        `${source.origin}/api/builder/provision?projection=1&requestId=${encodeURIComponent(requestId)}`,
        { method: "GET", headers },
      ),
    );

  const first = await read();
  if (!first.ok) return first;
  const initial = builderProvisionProjectionSchema.parse(await first.json());
  // Native reconnects advance the header; a new EventSource can only provide
  // its acknowledged cursor in the URL. Never let the initial URL override it.
  const cursor =
    request.headers.get("last-event-id") ?? source.searchParams.get("afterRevision") ?? "0";
  const parsedCursor = /^[0-9]+$/u.test(cursor) ? Number(cursor) : 0;
  const lastEventId = Number.isSafeInteger(parsedCursor) ? parsedCursor : 0;
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastWrite = Date.now();
  const delay = (ms: number) =>
    new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        timer = undefined;
        resolve();
      }, ms);
    });

  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      // The polling loop observes this flag before and after each await.
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
    async start(controller) {
      let lastRevision = Number.isSafeInteger(lastEventId) ? lastEventId : 0;
      const started = Date.now();
      let current: BuilderProvisionProjection = initial;
      try {
        while (true) {
          if (cancelled) return;
          if (current.revision > lastRevision) {
            controller.enqueue(event(current, String(current.revision)));
            lastRevision = current.revision;
            lastWrite = Date.now();
          }
          if (current.provisioning.status === "settled" || Date.now() - started >= maxStreamMs) {
            controller.enqueue(event(current, String(current.revision), "end"));
            controller.close();
            return;
          }
          if (Date.now() - lastWrite >= heartbeatIntervalMs) {
            controller.enqueue(heartbeat());
            lastWrite = Date.now();
          }
          // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
          await delay(pollIntervalMs);
          if (cancelled) return;
          // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
          const response = await read();
          if (!response.ok) {
            controller.enqueue(event({ error: "provisioning_unavailable" }, "error", "error"));
            controller.close();
            return;
          }
          // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
          current = builderProvisionProjectionSchema.parse(await response.json());
        }
      } catch {
        if (!cancelled) {
          controller.enqueue(event({ error: "provisioning_stream_failed" }, "error", "error"));
          controller.close();
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Cache-Control": "no-cache, no-store",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream; charset=utf-8",
      "X-Accel-Buffering": "no",
    },
  });
}
