import { randomUUID } from "node:crypto";

import { Suspense, ViewTransition } from "react";

import { headers } from "next/headers";
import { connection } from "next/server";

import {
  readAuthenticatedActiveBuilderDraft,
  readAuthenticatedBuilderDraft,
} from "@/lib/builder-drafts/deployment";
import { ensurePreviewOAuthDeploymentSessionOrganization } from "@/lib/auth/preview-oauth-deployment";
import { resolveWorkspaceOnboardingState } from "@/lib/auth/workspace-onboarding";
import { loadBuilderIntegrationState } from "@/lib/integrations/builder-integration-deployment";
import {
  builderComingSoonFlag,
  builderConnectionsFlag,
  builderResourceProvisioningFlag,
} from "@/lib/feature-flags";
import {
  parseProviderConnectionFailureReason,
  type ProviderConnectionNotice,
} from "@/lib/integrations/provider-connection-status";
import { parseProviderResumeKey } from "@/lib/integrations/provider-connection-return";

import { AppBuilder } from "./ui/app-builder";
import type { BuilderDraft } from "./ui/builder-types";
import { WorkspaceOnboarding } from "./ui/workspace-onboarding";
import {
  clearBuilderDraft,
  loadActiveBuilderDraft,
  saveActiveBuilderDraft,
} from "./actions/builder-drafts";

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
  const state = await resolveWorkspaceOnboardingState(async () =>
    ensurePreviewOAuthDeploymentSessionOrganization({
      environment: process.env,
      headers: await headers(),
    }),
  );
  if (state.status === "anonymous") {
    console.warn(
      JSON.stringify({
        level: "error",
        message: "preview_workspace_reconciliation_skipped",
        reason: "session_unavailable",
      }),
    );
    return state;
  }
  if (state.status !== "ready") {
    console.error(
      JSON.stringify({
        level: "error",
        message: "preview_workspace_reconciliation_failed",
        reason: state.status,
      }),
    );
    return state;
  }
  return {
    status: "ready" as const,
    user: {
      id: state.value.user.id,
      name: state.value.user.name || "Autograph user",
      email: state.value.user.email,
      organizationId: state.value.organization.organizationId,
      workspaceId: state.value.organization.workspaceId,
    },
  };
}

async function HomeContent({ searchParams }: PageProps) {
  await connection();
  const [
    query,
    user,
    connectionsEnabled,
    comingSoonEnabled,
    provisioningEnabled,
  ] = await Promise.all([
    searchParams,
    currentUser(),
    builderConnectionsFlag(),
    builderComingSoonFlag(),
    builderResourceProvisioningFlag(),
  ]);
  const mode = typeof query.mode === "string" ? query.mode : undefined;
  const notices: ProviderConnectionNotice[] = [];
  for (const provider of ["vercel", "github"] as const) {
    const status = query[provider];
    if (status !== "connected" && status !== "failed") continue;
    if (provider === "github" && status === "failed") continue;
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
  if (
    user.status === "workspace-setup-retry" ||
    user.status === "workspace-ambiguous" ||
    user.status === "access-denied"
  )
    return <WorkspaceOnboarding status={user.status} />;

  const authenticated = user.status === "ready";
  const resumeKey = parseProviderResumeKey(query.resume);
  const durableDraft = authenticated
    ? resumeKey
      ? await readAuthenticatedBuilderDraft({
          environment: process.env,
          headers: await headers(),
          draftId: resumeKey,
        })
      : await readAuthenticatedActiveBuilderDraft({
          environment: process.env,
          headers: await headers(),
        })
    : undefined;
  const integrations = await loadBuilderIntegrationState({
    environment: process.env,
    ...(user.status === "ready"
      ? {
          authenticated: true as const,
          userId: user.user.id,
          organizationId: user.user.organizationId,
          workspaceId: user.user.workspaceId,
        }
      : { authenticated: false as const }),
  });

  return (
    <AppBuilder
      authenticated={authenticated && mode !== "anonymous"}
      generatedNameSeed={randomUUID()}
      connectionsEnabled={connectionsEnabled}
      comingSoonEnabled={comingSoonEnabled}
      provisioningEnabled={provisioningEnabled}
      integrations={integrations}
      providerNotices={notices}
      providerResumeKey={resumeKey}
      initialDurableDraft={
        durableDraft?.record.draft as BuilderDraft | undefined
      }
      durableDraftId={durableDraft?.draftId}
      durableDraftRevision={durableDraft?.revision}
      durableDraftUpdatedAt={durableDraft?.updatedAt}
      saveActiveBuilderDraftAction={saveActiveBuilderDraft}
      loadActiveBuilderDraftAction={loadActiveBuilderDraft}
      clearBuilderDraftAction={clearBuilderDraft}
    />
  );
}

function BuilderLoading() {
  return <main id="main-content" aria-busy="true" />;
}

export default function Home(props: PageProps) {
  return (
    <Suspense fallback={<BuilderLoading />}>
      <ViewTransition>
        <HomeContent {...props} />
      </ViewTransition>
    </Suspense>
  );
}
