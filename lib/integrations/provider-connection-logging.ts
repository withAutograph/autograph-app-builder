import type { ProviderConnectionFailureReason } from "./provider-connection-status";

export function logProviderConnectionFailure(input: {
  request: Request;
  provider: "github" | "vercel";
  phase: "start" | "callback";
  reason: ProviderConnectionFailureReason;
  startedAt: number;
}) {
  console.error(
    JSON.stringify({
      level: "error",
      message: "provider_connection_failed",
      provider: input.provider,
      phase: input.phase,
      reason: input.reason,
      requestId: input.request.headers.get("x-vercel-id") ?? "unavailable",
      durationMs: Math.max(0, Date.now() - input.startedAt),
    }),
  );
}
