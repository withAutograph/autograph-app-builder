import { headers } from "next/headers";

import { ensurePreviewOAuthDeploymentSessionOrganization } from "@/lib/auth/preview-oauth-deployment";
import { OrganizationProvisioningError } from "@/lib/auth/preview-user-management";
import { loadBuilderIntegrationState } from "@/lib/integrations/builder-integration-deployment";
import {
  parseProviderConnectionFailureReason,
  type ProviderConnectionNotice,
} from "@/lib/integrations/provider-connection-status";
import { parseProviderResumeKey } from "@/lib/integrations/provider-connection-return";

import { AppBuilder } from "./ui/app-builder";

type PageProps = {
  searchParams: Promise<{
    mode?: string | string[];
    vercel?: string | string[];
    github?: string | string[];
    reason?: string | string[];
    vercelReason?: string | string[];
    githubReason?: string | string[];
    resume?: string | string[];
  }>;
};

async function currentUser() {
  try {
    const user = await ensurePreviewOAuthDeploymentSessionOrganization({
      environment: process.env,
      headers: await headers(),
    });
    if (!user) {
      console.error(
        JSON.stringify({
          level: "error",
          message: "preview_workspace_reconciliation_skipped",
          reason: "session_unavailable",
        }),
      );
      return undefined;
    }
    return {
      id: user.user.id,
      name: user.user.name || "Autograph user",
      email: user.user.email,
      workspaceId: user.organization.workspaceId,
    };
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        message: "preview_workspace_reconciliation_failed",
        reason:
          error instanceof OrganizationProvisioningError
            ? error.reason
            : "unexpected",
      }),
    );
    return undefined;
  }
}

export default async function Home({ searchParams }: PageProps) {
  const [query, user] = await Promise.all([searchParams, currentUser()]);
  const mode = typeof query.mode === "string" ? query.mode : undefined;
  const notices: ProviderConnectionNotice[] = [];
  for (const provider of ["vercel", "github"] as const) {
    const status = query[provider];
    if (status !== "connected" && status !== "failed") continue;
    notices.push({
      provider,
      status,
      ...(status === "failed"
        ? {
            reason: parseProviderConnectionFailureReason(
              query[provider === "vercel" ? "vercelReason" : "githubReason"] ??
                query.reason,
            ),
          }
        : {}),
    });
  }
  const authenticated =
    user !== undefined ||
    (process.env.NODE_ENV !== "production" && mode === "authenticated");
  const integrations = await loadBuilderIntegrationState({
    environment: process.env,
    userId: user?.id,
    workspaceId: user?.workspaceId,
  });

  return (
    <AppBuilder
      authenticated={authenticated && mode !== "anonymous"}
      integrations={integrations}
      providerNotices={notices}
      providerResumeKey={parseProviderResumeKey(query.resume)}
    />
  );
}
