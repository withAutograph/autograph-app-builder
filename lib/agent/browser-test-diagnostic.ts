const accessStages = [
  "recording-policy",
  "fixture-scope",
  "preview-bootstrap",
  "preview-refresh-required",
  "signed-out-session",
  "auth-ui",
  "auth-session",
  "fixture-recheck",
  "protected-operation",
  "context-cleanup",
  "readback-runtime-unavailable",
  "readback-actor-not-authorized",
  "readback-scope-closed",
  "readback-release-unavailable",
  "readback-unavailable",
] as const;

const testCategories = ["assertion", "timeout", "navigation", "browser-launch"] as const;

/** Only exact allowlisted reporter lines become structured private diagnostics. */
export const privateBrowserFailureDiagnostic = (stdout: string) => {
  const lines = new Set(stdout.split(/\r?\n/u));
  const stages = accessStages.filter((stage) => lines.has(`[private browser stage] ${stage}`));
  const categories = testCategories.filter((category) =>
    lines.has(`[private browser category] ${category}`),
  );
  return { categories, stages };
};

export const privateBrowserFailureRecovery = (
  diagnostic: ReturnType<typeof privateBrowserFailureDiagnostic>,
): string => {
  if (diagnostic.stages.length > 0) {
    return "The browser failed during access setup or protected readback. Inspect the reported stage and restore the existing owner-bound session or runtime binding before testing the app again; do not weaken application authorization.";
  }
  if (diagnostic.categories.includes("browser-launch")) {
    return "The browser could not launch. Repair the sandbox browser runtime before changing application code.";
  }
  if (diagnostic.categories.includes("navigation")) {
    return "Browser navigation failed. Check the current preview, app entry path and server availability before changing application assertions.";
  }
  if (diagnostic.categories.includes("assertion")) {
    return "An application assertion failed. Inspect the reported app-owned test location and repair the requested behavior, preserving its access rules and expected behavior.";
  }
  if (diagnostic.categories.includes("timeout")) {
    return "A browser operation timed out. Inspect the reported test location and determine whether access, navigation or the app interaction stopped before retrying; do not infer a passing behavior from a ready preview.";
  }
  return "The private reporter did not identify the failure category. Inspect the reported test location and available sanitized diagnostics before retrying; do not infer an app defect or a passing behavior from an unclassified failure.";
};
