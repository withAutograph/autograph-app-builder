import { sanitizeValidationDiagnosticText } from "./validation-output-sanitize";
import type { ValidationLogChannel } from "./validation-log";

/** Positive native checker panic evidence only; exit codes alone do not establish a cause. */
const checkerPanic =
  /\bthread\s+'[^'\r\n]+'(?:\s+\(\d+\))?\s+panicked at\s+[^\r\n]*\b(?:oxc_allocator|oxc_linter|oxlint)\/[^\r\n]*:\d+:\d+:/u;
const CHUNK_BOUNDARY_CONTEXT = 4096;
export const createValidationToolingFailureObserver = () => {
  const tails: Record<ValidationLogChannel, string> = { stdout: "", stderr: "" };
  let nativeCheckerPanicked = false;
  return {
    observe(channel: ValidationLogChannel, content: string) {
      // The bounded tail handles a diagnostic split across transport chunks.
      // Complete sanitized output continues through the ordinary durable log writer.
      const text = sanitizeValidationDiagnosticText(tails[channel] + content);
      nativeCheckerPanicked ||= checkerPanic.test(text);
      tails[channel] = text.slice(-CHUNK_BOUNDARY_CONTEXT);
    },
    classification() {
      return nativeCheckerPanicked ? ("native-tool-panic" as const) : undefined;
    },
  };
};
export const toolingFailureHint =
  "The validation checker panicked before completing. Preserve the app source and inspect its tooling or execution prerequisites before retrying. If the supported larger private-check profile is appropriate, prepare a same-app proposal with prepare_app_creation privateCompute=private-checks-16gib-v1 and present its ordinary fresh Build approval (8 vCPU, 16 GiB and ephemeral billing) before any apply. Preserve the existing Sandbox, Drive and app destination; a prior approval never authorizes that changed proposal. If profile prerequisites are unavailable, report them without resizing. The exit code alone does not establish an out-of-memory cause.";
