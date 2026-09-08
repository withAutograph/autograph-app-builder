import { OrganizationProvisioningError } from "./preview-user-management";

export type WorkspaceOnboardingFailure =
  "access-denied" | "workspace-ambiguous" | "workspace-setup-retry";

export type WorkspaceOnboardingState<T> =
  | { status: "anonymous" }
  | { status: "ready"; value: T }
  | { status: WorkspaceOnboardingFailure };

export async function resolveWorkspaceOnboardingState<T>(
  ensure: () => Promise<T | undefined>,
): Promise<WorkspaceOnboardingState<T>> {
  try {
    const value = await ensure();
    return value === undefined
      ? { status: "anonymous" }
      : { status: "ready", value };
  } catch (error) {
    if (error instanceof OrganizationProvisioningError) {
      if (error.reason === "workspace-ambiguous")
        return { status: "workspace-ambiguous" };
      if (
        error.reason === "access-revoked" ||
        error.reason === "verified-identity-required" ||
        error.reason === "signup-disabled"
      )
        return { status: "access-denied" };
    }
    return { status: "workspace-setup-retry" };
  }
}

export function workspaceOnboardingRedirect(
  origin: string,
  failure: WorkspaceOnboardingFailure,
) {
  const url = new URL("/", origin);
  url.searchParams.set("onboarding", failure);
  return url.toString();
}

export function signInForWorkspaceRedirect(origin: string) {
  const url = new URL("/auth/sign-in", origin);
  url.searchParams.set("callbackURL", "/");
  return url.toString();
}
