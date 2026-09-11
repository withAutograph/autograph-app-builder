import { getBuilderProvisioningDeploymentHandler } from "@/lib/provisioning/deployment";

const encoder = new TextEncoder();
const pollIntervalMs = 250;
const maxStreamMs = 30_000;
const heartbeatIntervalMs = 10_000;

function event(data: unknown, id: string, name = "snapshot") {
  return encoder.encode(
    `id: ${id}\nevent: ${name}\ndata: ${JSON.stringify(data)}\n\n`,
  );
}

function heartbeat() {
  return encoder.encode(": keep-alive\n\n");
}

/**
 * Stream the durable provisioning journal to the browser. The journal remains
 * the source of truth; SSE only provides a low-latency projection of its
 * revisions and therefore survives reconnects through the normal GET route.
 */
export async function GET(request: Request) {
  const source = new URL(request.url);
  const requestId = source.searchParams.get("requestId");
  if (!requestId)
    return Response.json({ error: "request_invalid" }, { status: 400 });

  const handler = getBuilderProvisioningDeploymentHandler(process.env);
  const headers = new Headers(request.headers);
  headers.set("accept", "application/json");
  const read = () =>
    handler(
      new Request(
        `${source.origin}/api/builder/provision?requestId=${encodeURIComponent(requestId)}`,
        { method: "GET", headers },
      ),
    );

  const first = await read();
  if (!first.ok) return first;
  const initial = await first.json();
  const lastEventId = request.headers.get("last-event-id");
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
      let lastUpdatedAt = lastEventId ?? "";
      const started = Date.now();
      let current = initial as { status?: string; updatedAt?: string };
      try {
        while (true) {
          if (cancelled) return;
          const updatedAt = current.updatedAt ?? "";
          if (updatedAt !== lastUpdatedAt) {
            controller.enqueue(event(current, updatedAt));
            lastUpdatedAt = updatedAt;
            lastWrite = Date.now();
          }
          if (
            current.status === "settled" ||
            Date.now() - started >= maxStreamMs
          ) {
            controller.enqueue(event(current, updatedAt || "end", "end"));
            controller.close();
            return;
          }
          if (Date.now() - lastWrite >= heartbeatIntervalMs) {
            controller.enqueue(heartbeat());
            lastWrite = Date.now();
          }
          await delay(pollIntervalMs);
          if (cancelled) return;
          const response = await read();
          if (!response.ok) {
            controller.enqueue(
              event({ error: "provisioning_unavailable" }, "error", "error"),
            );
            controller.close();
            return;
          }
          current = (await response.json()) as typeof current;
        }
      } catch {
        if (!cancelled) {
          controller.enqueue(
            event({ error: "provisioning_stream_failed" }, "error", "error"),
          );
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
