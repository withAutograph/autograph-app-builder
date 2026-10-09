import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import type { MessageStreamEvent } from "eve/client";

const phaseSchema = z.enum([
  "authority",
  "workload_identity",
  "fetch",
  "headers",
  "decode",
  "private_callback",
  "public_spool",
  "checkpoint",
]);
const counterSchema = z.enum([
  "nativeStartIndex",
  "nativeNextIndex",
  "bodyBytes",
  "decodedEvents",
  "privateCallbacks",
  "publicSpoolEvents",
  "prepareWorkspaceRequested",
  "prepareWorkspaceCompleted",
  "prepareWorkspaceFailed",
  "resolveGithubSourceRequested",
  "resolveGithubSourceCompleted",
  "resolveGithubSourceFailed",
]);
// Installed Eve action schema supplies toolName/kind and an explicit result status.
// This projector reads no call IDs, tool inputs, output, error or presentation fields.
const nativeActionCounter = (
  toolName: string,
  status: string,
): z.infer<typeof counterSchema> | undefined => {
  if (toolName !== "prepare_workspace" && toolName !== "resolve_github_source") {
    return undefined;
  }
  if (status !== "completed" && status !== "failed" && status !== "requested") {
    return undefined;
  }
  const counters = {
    prepare_workspace: {
      completed: "prepareWorkspaceCompleted",
      failed: "prepareWorkspaceFailed",
      requested: "prepareWorkspaceRequested",
    },
    resolve_github_source: {
      completed: "resolveGithubSourceCompleted",
      failed: "resolveGithubSourceFailed",
      requested: "resolveGithubSourceRequested",
    },
  } as const;
  return counters[toolName][status];
};
const failureCategory = {
  authority: "authority_failure",
  checkpoint: "checkpoint_failure",
  decode: "decode_failure",
  fetch: "fetch_failure",
  headers: "invalid_stream_contract",
  private_callback: "private_callback_failure",
  public_spool: "public_spool_failure",
  workload_identity: "workload_identity_failure",
} as const;
export interface HostedReadDiagnostic {
  event: "builder.hosted_read";
  outcome: "completed" | "failed" | "timeout";
  category: "none" | "deadline" | (typeof failureCategory)[keyof typeof failureCategory];
  phase: z.infer<typeof phaseSchema>;
  sessionIdHash: string;
  elapsedMs: number;
  phaseElapsedMs: number;
  nativeStartIndex: number;
  nativeNextIndex: number;
  bodyBytes: number;
  decodedEvents: number;
  privateCallbacks: number;
  publicSpoolEvents: number;
  prepareWorkspaceRequested: number;
  prepareWorkspaceCompleted: number;
  prepareWorkspaceFailed: number;
  resolveGithubSourceRequested: number;
  resolveGithubSourceCompleted: number;
  resolveGithubSourceFailed: number;
}
export type HostedReadDiagnosticSink = (diagnostic: HostedReadDiagnostic) => void | Promise<void>;

/** Diagnostic only: no exception object, message, URL, request, credentials or recovery authority. */
export const createHostedReadTrace = (input: {
  sessionId: string;
  sink?: HostedReadDiagnosticSink;
  now?: () => number;
}) => {
  const clock = input.now ?? (() => performance.now());
  const readClock = () => {
    try {
      const value = clock();
      return Number.isFinite(value) ? value : 0;
    } catch {
      return 0;
    }
  };
  const started = readClock();
  let phaseStarted = started;
  let phase: z.infer<typeof phaseSchema> = "authority";
  let reported = false;
  let expired = false;
  const counters = {
    bodyBytes: 0,
    decodedEvents: 0,
    nativeNextIndex: 0,
    nativeStartIndex: 0,
    prepareWorkspaceCompleted: 0,
    prepareWorkspaceFailed: 0,
    prepareWorkspaceRequested: 0,
    privateCallbacks: 0,
    publicSpoolEvents: 0,
    resolveGithubSourceCompleted: 0,
    resolveGithubSourceFailed: 0,
    resolveGithubSourceRequested: 0,
  };
  const sessionIdHash = `sha256:${createHash("sha256").update(input.sessionId).digest("hex")}`;
  const emit = (outcome: HostedReadDiagnostic["outcome"]) => {
    if (reported) {
      return;
    }
    reported = true;
    const at = readClock();
    let category: HostedReadDiagnostic["category"] = failureCategory[phase];
    if (outcome === "completed") {
      category = "none";
    } else if (outcome === "timeout") {
      category = "deadline";
    }
    const diagnostic: HostedReadDiagnostic = {
      category,
      elapsedMs: Math.max(0, Math.round(at - started)),
      event: "builder.hosted_read",
      outcome,
      phase,
      phaseElapsedMs: Math.max(0, Math.round(at - phaseStarted)),
      sessionIdHash,
      ...counters,
    };
    try {
      if (input.sink === undefined) {
        console.info("[builder:hosted-read]", diagnostic);
      } else {
        const deliver = async () => {
          try {
            await input.sink?.(diagnostic);
          } catch {
            /* Diagnostic only. */
          }
        };
        void deliver();
      }
    } catch {
      /* A sink must never change reader behavior. */
    }
  };
  const increment = (counter: z.infer<typeof counterSchema>, amount = 1) => {
    if (
      counterSchema.safeParse(counter).success &&
      Number.isSafeInteger(amount) &&
      amount >= 0 &&
      Number.isSafeInteger(counters[counter] + amount)
    ) {
      counters[counter] += amount;
    }
  };
  return {
    completed() {
      emit("completed");
    },
    enter(next: z.infer<typeof phaseSchema>) {
      const value = phaseSchema.safeParse(next);
      if (value.success) {
        phase = value.data;
        phaseStarted = readClock();
      }
    },
    failed() {
      emit(expired ? "timeout" : "failed");
    },
    increment,
    /** Counts only consumed native metadata; cursor bounds describe this observation's interval. */
    observeNativeAction(event: MessageStreamEvent) {
      try {
        const count = (toolName: string, status: string) => {
          const counter = nativeActionCounter(toolName, status);
          if (counter !== undefined) {
            increment(counter);
          }
        };
        if (event.type === "actions.requested") {
          for (const action of event.data.actions) {
            if (action.kind === "tool-call" || action.kind === "workflow-tool-call") {
              count(action.toolName, "requested");
            }
          }
        } else if (event.type === "action.result" && event.data.result.kind === "tool-result") {
          count(event.data.result.toolName, event.data.status);
        }
      } catch {
        /* Malformed diagnostic metadata must never change stream behavior. */
      }
    },
    set(counter: z.infer<typeof counterSchema>, value: number) {
      if (counterSchema.safeParse(counter).success && Number.isSafeInteger(value) && value >= 0) {
        counters[counter] = value;
      }
    },
    watch(signal?: AbortSignal) {
      const report = () => {
        expired = true;
        emit("timeout");
      };
      if (signal?.aborted === true) {
        report();
      } else {
        signal?.addEventListener("abort", report, { once: true });
      }
      return () => signal?.removeEventListener("abort", report);
    },
  };
};
export type HostedReadTrace = ReturnType<typeof createHostedReadTrace>;
