import type { ProviderConnectionFailureReason } from "./provider-connection-status";

export function logProviderConnectionFailure(input: {
  request: Request;
  provider: "github" | "vercel";
  phase: "start" | "callback";
  reason: ProviderConnectionFailureReason;
  startedAt: number;
  diagnostic?: {
    stage: string;
    category?: string;
    callback?: {
      queryKeys: string[];
      statePresent: boolean;
      stateLength?: number;
      error?: string;
    };
  };
}) {
  console.error(
    JSON.stringify({
      level: "error",
      message: "provider_connection_failed",
      provider: input.provider,
      phase: input.phase,
      reason: input.reason,
      ...(input.diagnostic === undefined
        ? {}
        : { diagnostic: input.diagnostic }),
      requestId: input.request.headers.get("x-vercel-id") ?? "unavailable",
      durationMs: Math.max(0, Date.now() - input.startedAt),
    }),
  );
}
