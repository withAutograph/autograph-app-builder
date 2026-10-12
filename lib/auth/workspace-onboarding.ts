import { OrganizationProvisioningError } from "./preview-user-management";

export type WorkspaceOnboardingFailure =
  | "access-denied"
  | "workspace-ambiguous"
  | "workspace-setup-retry";

export type WorkspaceOnboardingState<T> =
  | { status: "anonymous" }
  | { status: "ready"; value: T }
  | { status: WorkspaceOnboardingFailure };

export type WorkspaceOnboardingStage =
  | "runtime-initialization"
  | "session-lookup"
  | "workspace-provisioning"
  | "organization-activation"
  | "unknown";

interface WorkspaceOnboardingDiagnostic {
  category:
    // oxlint-disable-next-line sonarjs/max-union-size -- Finite diagnostic categories are the safe log contract.
    | "access-revoked"
    | "ambiguous"
    | "identity-required"
    | "signup-disabled"
    | "unexpected"
    | "workspace-setup-failed";
  stage: WorkspaceOnboardingStage;
}

const workspaceOnboardingStages = new WeakMap<object, WorkspaceOnboardingStage>();

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, sonarjs/no-duplicate-string -- JavaScript rejections may be arbitrary values; preserve them and inspect only weak-key eligibility and finite domain literals. */
// Keep diagnostics independent of exception messages, provider payloads, and identities.
const workspaceOnboardingCategory = (error: unknown): WorkspaceOnboardingDiagnostic["category"] => {
  if (!(error instanceof OrganizationProvisioningError)) {
    return "unexpected";
  }
  switch (error.reason) {
    case "access-revoked": {
      return "access-revoked";
    }
    case "workspace-ambiguous": {
      return "ambiguous";
    }
    case "verified-identity-required": {
      return "identity-required";
    }
    case "signup-disabled": {
      return "signup-disabled";
    }
    case "workspace-setup-failed": {
      return "workspace-setup-failed";
    }
    default: {
      return "unexpected";
    }
  }
};

// eslint-disable-next-line eslint/func-style -- Keep diagnostic output machine-readable.
export function logWorkspaceOnboardingFailure(error: unknown, stage: WorkspaceOnboardingStage) {
  try {
    if ((typeof error === "object" && error !== null) || typeof error === "function") {
      workspaceOnboardingStages.set(error, stage);
    }
    console.error(
      JSON.stringify({
        category: workspaceOnboardingCategory(error),
        event: "preview_workspace_reconciliation_failed",
        stage,
      }),
    );
  } catch {
    // Diagnostics must never replace the onboarding result or original failure.
  }
}

const hasWorkspaceOnboardingStage = (error: unknown) =>
  ((typeof error === "object" && error !== null) || typeof error === "function") &&
  workspaceOnboardingStages.has(error);

/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, sonarjs/no-duplicate-string */

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export async function resolveWorkspaceOnboardingState<T>(
  ensure: () => Promise<T | undefined>,
): Promise<WorkspaceOnboardingState<T>> {
  try {
    const value = await ensure();
    return value === undefined ? { status: "anonymous" } : { status: "ready", value };
  } catch (error) {
    if (!hasWorkspaceOnboardingStage(error)) {
      logWorkspaceOnboardingFailure(error, "unknown");
    }
    if (error instanceof OrganizationProvisioningError) {
      if (error.reason === "workspace-ambiguous") {
        return { status: "workspace-ambiguous" };
      }
      if (
        error.reason === "access-revoked" ||
        error.reason === "verified-identity-required" ||
        error.reason === "signup-disabled"
      ) {
        return { status: "access-denied" };
      }
    }
    return { status: "workspace-setup-retry" };
  }
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function workspaceOnboardingRedirect(origin: string, failure: WorkspaceOnboardingFailure) {
  const url = new URL("/", origin);
  url.searchParams.set("onboarding", failure);
  return url.toString();
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function signInForWorkspaceRedirect(origin: string) {
  const url = new URL("/auth/sign-in", origin);
  url.searchParams.set("callbackURL", "/");
  return url.toString();
}
