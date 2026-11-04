import { sanitizeValidationDiagnosticText } from "./validation-output-sanitize";
import type { ValidationLogChannel } from "./validation-log";

/** Positive native checker panic evidence only; exit codes alone do not establish a cause. */
const checkerPanic =
  /\bthread\s+'[^'\r\n]+'(?:\s+\(\d+\))?\s+panicked at\s+[^\r\n]*\b(?:oxc_allocator|oxc_linter|oxlint)\/[^\r\n]*:\d+:\d+:/u;
const CHUNK_BOUNDARY_CONTEXT = 4096;
export const createValidationToolingFailureObserver = (expectedAppCheckTask?: string) => {
  const missingExpectedTask = (text: string, complete: boolean) =>
    text
      .split(/\r?\n/u)
      .slice(0, complete ? undefined : -1)
      .some(
        (line) =>
          expectedAppCheckTask !== undefined &&
          line === `mise ERROR no task ${expectedAppCheckTask} found`,
      );
  const tails: Record<ValidationLogChannel, string> = { stdout: "", stderr: "" };
  let nativeCheckerPanicked = false;
  let appTaskMissing = false;
  return {
    observe(channel: ValidationLogChannel, content: string) {
      // The bounded tail handles a diagnostic split across transport chunks.
      // Complete sanitized output continues through the ordinary durable log writer.
      const text = sanitizeValidationDiagnosticText(tails[channel] + content);
      nativeCheckerPanicked ||= checkerPanic.test(text);
      appTaskMissing ||= missingExpectedTask(text, false);
      tails[channel] = text.slice(-CHUNK_BOUNDARY_CONTEXT);
    },
    classification() {
      if (appTaskMissing || Object.values(tails).some((tail) => missingExpectedTask(tail, true))) {
        return "missing-app-task" as const;
      }
      return nativeCheckerPanicked ? ("native-tool-panic" as const) : undefined;
    },
  };
};
export const toolingFailureHint =
  "The validation checker panicked before completing. Preserve the app source and inspect its tooling or execution prerequisites before retrying. If the supported larger private-check profile is appropriate, prepare a same-app proposal with prepare_app_creation privateCompute=private-checks-16gib-v1 and present its ordinary fresh Build approval (8 vCPU, 16 GiB and ephemeral billing) before any apply. Preserve the existing Sandbox, Drive and app destination; a prior approval never authorizes that changed proposal. If profile prerequisites are unavailable, report them without resizing. The exit code alone does not establish an out-of-memory cause.";

export const missingAppTaskHint =
  "The selected app's reviewed mise check task is unavailable. Preserve its source and inspect the app-owned task path and executable mode before retrying. Restore it through the normal reviewed Builder repair flow; repeated validation cannot repair a missing task, and this does not authorize changing the app destination or provider resources.";
