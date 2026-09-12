import { randomUUID } from "node:crypto";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { Suspense, ViewTransition } from "react";

import { ensurePreviewOAuthDeploymentSessionOrganization } from "@/lib/auth/preview-oauth-deployment";
import { resolveWorkspaceOnboardingState } from "@/lib/auth/workspace-onboarding";
import {
  readAuthenticatedActiveBuilderDraft,
  readAuthenticatedBuilderDraft,
} from "@/lib/builder-drafts/deployment";
import {
  builderComingSoonFlag,
  builderConnectionsFlag,
  builderResourceProvisioningFlag,
} from "@/lib/feature-flags";
import { loadBuilderIntegrationState } from "@/lib/integrations/builder-integration-deployment";
import { findAuthenticatedPendingBuilderHandoff } from "@/lib/handoff/deployment";
import { parseProviderResumeKey } from "@/lib/integrations/provider-connection-return";
import { parseProviderConnectionFailureReason } from "@/lib/integrations/provider-connection-status";
import type { ProviderConnectionNotice } from "@/lib/integrations/provider-connection-status";

import {
  clearBuilderDraft,
  loadActiveBuilderDraft,
  saveActiveBuilderDraft,
} from "../actions/builder-drafts";
import { AnonymousBuilder } from "../ui/anonymous-builder";
import { AuthenticatedBuilder } from "../ui/authenticated-builder";
import { BuilderLoadingShell } from "../ui/builder-loading-shell";
import { Header } from "../ui/builder-shell";
import styles from "../ui/app-builder.module.css";
import type { BuilderDraft } from "../ui/builder-types";
import { WorkspaceOnboarding } from "../ui/workspace-onboarding";

interface PageProps {
  searchParams: Promise<{
    mode?: string | string[];
    vercel?: string | string[];
    github?: string | string[];
    reason?: string | string[];
    vercelReason?: string | string[];
    githubReason?: string | string[];
    resume?: string | string[];
  }>;
}

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
      email: state.value.user.email,
      id: state.value.user.id,
      name: state.value.user.name || "Autograph user",
      organizationId: state.value.organization.organizationId,
      workspaceId: state.value.organization.workspaceId,
    },
  };
}

async function HomeContent({ searchParams }: PageProps) {
  await connection();
  const [query, user] = await Promise.all([searchParams, currentUser()]);
  const mode = typeof query.mode === "string" ? query.mode : undefined;
  const notices: ProviderConnectionNotice[] = [];
  for (const provider of ["vercel", "github"] as const) {
    const status = query[provider];
    if (status !== "connected" && status !== "failed") {
      continue;
    }
    if (provider === "github" && status === "failed") {
      continue;
    }
    notices.push({
      provider,
      status,
      ...(status === "failed"
        ? {
            reason: parseProviderConnectionFailureReason(
              query[provider === "vercel" ? "vercelReason" : "githubReason"] ?? query.reason,
            ),
          }
        : {}),
    });
  }
  if (
    user.status === "workspace-setup-retry" ||
    user.status === "workspace-ambiguous" ||
    user.status === "access-denied"
  ) {
    return <WorkspaceOnboarding status={user.status} />;
  }

  const authenticated = user.status === "ready";
  const resumeKey = parseProviderResumeKey(query.resume);
  if (!authenticated || mode === "anonymous") return <AnonymousBuilder />;

  const [connectionsEnabled, comingSoonEnabled, provisioningEnabled] = await Promise.all([
    builderConnectionsFlag(),
    builderComingSoonFlag(),
    builderResourceProvisioningFlag(),
  ]);

  if (!resumeKey) {
    const pendingHandoff = await findAuthenticatedPendingBuilderHandoff({
      environment: process.env,
      headers: await headers(),
    });
    if (pendingHandoff) redirect(`/handoff/${encodeURIComponent(pendingHandoff.handoffId)}`);
  }
  const durableDraft = resumeKey
    ? await readAuthenticatedBuilderDraft({
        draftId: resumeKey,
        environment: process.env,
        headers: await headers(),
      })
    : await readAuthenticatedActiveBuilderDraft({
        environment: process.env,
        headers: await headers(),
      });
  const integrations = await loadBuilderIntegrationState({
    environment: process.env,
    authenticated: true as const,
    organizationId: user.user.organizationId,
    userId: user.user.id,
    workspaceId: user.user.workspaceId,
  });

  return (
    <div className={styles.appShell}>
      <Header />
      <AuthenticatedBuilder
        generatedNameSeed={randomUUID()}
        connectionsEnabled={connectionsEnabled}
        comingSoonEnabled={comingSoonEnabled}
        provisioningEnabled={provisioningEnabled}
        integrations={integrations}
        providerNotices={notices}
        providerResumeKey={resumeKey}
        initialDurableDraft={durableDraft?.record.draft as BuilderDraft | undefined}
        durableDraftId={durableDraft?.draftId}
        durableDraftRevision={durableDraft?.revision}
        durableDraftUpdatedAt={durableDraft?.updatedAt}
        saveActiveBuilderDraftAction={saveActiveBuilderDraft}
        loadActiveBuilderDraftAction={loadActiveBuilderDraft}
        clearBuilderDraftAction={clearBuilderDraft}
      />
    </div>
  );
}

export default function Home(props: PageProps) {
  return (
    <Suspense fallback={<BuilderLoadingShell />}>
      {/* Animate navigation, not autosave updates around editable controls. */}
      <ViewTransition update="none">
        <HomeContent {...props} />
      </ViewTransition>
    </Suspense>
  );
}
