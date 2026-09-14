import { defineState } from "eve/context";

import type { PreviewAttempt } from "../sandbox/working-preview-ownership";
import type { WorkingPreviewRuntime } from "../sandbox/working-preview-runtime";

export const workingPreviewState = defineState<WorkingPreviewRuntime | null>(
  "autograph-app-builder.working-preview.v1",
  () => null,
);

export const hasLiveWorkingPreview = (
  preview: WorkingPreviewRuntime | null,
  sandboxId: string,
  now = Date.now(),
): boolean =>
  preview !== null &&
  preview.sandboxId === sandboxId &&
  Date.parse(preview.receipt.expiresAt) > now;

// Projection for lifecycle cleanup; the sandbox journal owns mid-step concurrency.
export const workingPreviewAttemptState = defineState<PreviewAttempt | null>(
  "autograph-app-builder.working-preview-attempt.v1",
  () => null,
);
