import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { AccountSettings } from "@/components/auth/settings/account/account-settings";
import { ensurePreviewOAuthDeploymentSessionOrganization } from "@/lib/auth/preview-oauth-deployment";
import {
  resolveWorkspaceOnboardingState,
  signInForWorkspaceRedirect,
  workspaceOnboardingRedirect,
} from "@/lib/auth/workspace-onboarding";

export default async function AccountSettingsPage() {
  const requestHeaders = await headers();
  const origin = new URL(
    process.env.BETTER_AUTH_URL ?? "http://localhost:3000/api/auth",
  ).origin;
  const state = await resolveWorkspaceOnboardingState(() =>
    ensurePreviewOAuthDeploymentSessionOrganization({
      environment: process.env,
      headers: requestHeaders,
    }),
  );
  if (state.status === "anonymous")
    redirect(signInForWorkspaceRedirect(origin));
  if (state.status !== "ready")
    redirect(workspaceOnboardingRedirect(origin, state.status));

  return (
    <main className="mx-auto flex min-h-svh w-full max-w-2xl flex-col gap-6 p-6">
      <h1 className="text-2xl font-semibold">Account settings</h1>
      <AccountSettings />
    </main>
  );
}
