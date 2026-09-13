import type { ProviderConnectionFailureReason } from "./provider-connection-status";

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
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
      keyCounts: Record<string, number>;
      unknownKeyCount: number;
      safeUnknownKeyNames?: string[];
      unknownKeyDigests?: string[];
      codePresent: boolean;
      codeLength?: number;
      statePresent: boolean;
      stateLength?: number;
      error?: string;
    };
    stateValidation?: { substage: string; stateDigest?: string };
  };
}) {
  console.error(
    JSON.stringify({
      ...(input.diagnostic === undefined ? {} : { diagnostic: input.diagnostic }),
      durationMs: Math.max(0, Date.now() - input.startedAt),
      level: "error",
      message: "provider_connection_failed",
      phase: input.phase,
      provider: input.provider,
      reason: input.reason,
      requestId: input.request.headers.get("x-vercel-id") ?? "unavailable",
    }),
  );
}
