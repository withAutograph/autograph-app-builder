import { getBuilderProvisioningDeploymentHandler } from "@/lib/provisioning/deployment";

const encoder = new TextEncoder();
const pollIntervalMs = 250;
const maxStreamMs = 30_000;

function event(data: unknown, name = "snapshot") {
  return encoder.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
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

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let lastUpdatedAt = "";
      const started = Date.now();
      let current = initial as { status?: string; updatedAt?: string };
      try {
        while (true) {
          const updatedAt = current.updatedAt ?? "";
          if (updatedAt !== lastUpdatedAt) {
            controller.enqueue(event(current));
            lastUpdatedAt = updatedAt;
          }
          if (
            current.status === "settled" ||
            Date.now() - started >= maxStreamMs
          ) {
            controller.enqueue(
              event({ status: current.status ?? "pending" }, "end"),
            );
            controller.close();
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
          const response = await read();
          if (!response.ok) {
            controller.enqueue(
              event({ error: "provisioning_unavailable" }, "error"),
            );
            controller.close();
            return;
          }
          current = (await response.json()) as typeof current;
        }
      } catch {
        controller.error(new Error("provisioning_stream_failed"));
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
