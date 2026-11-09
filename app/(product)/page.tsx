import { randomUUID } from "node:crypto";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { ViewTransition } from "react";

import { RouteProviders } from "@/components/route-providers";

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
import { loadNextGatewayModels } from "@/lib/integrations/ai-gateway-models.next";
import { findAuthenticatedPendingBuilderHandoff } from "@/lib/handoff/deployment";
import { parseProviderResumeKey } from "@/lib/integrations/provider-connection-return";
import { parseProviderConnectionFailureReason } from "@/lib/integrations/provider-connection-status";
import type { ProviderConnectionNotice } from "@/lib/integrations/provider-connection-status";

import { loadActiveBuilderDraft, saveActiveBuilderDraft } from "../actions/builder-drafts";
import { AnonymousBuilder } from "../ui/anonymous-builder";
import { AuthenticatedBuilder } from "../ui/authenticated-builder";
import { BuilderLoadingShell } from "../ui/builder-loading-shell";
import { Header } from "../ui/builder-shell";
import styles from "../ui/app-builder.module.css";
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

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
async function currentUser() {
  const state = await resolveWorkspaceOnboardingState(
    async () =>
      await ensurePreviewOAuthDeploymentSessionOrganization({
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

// eslint-disable-next-line eslint/func-style -- Keep the existing declaration style.
function providerNotices(query: Awaited<PageProps["searchParams"]>): ProviderConnectionNotice[] {
  const notices: ProviderConnectionNotice[] = [];
  for (const provider of ["vercel", "github"] as const) {
    const status = query[provider];
    if (status !== "connected" && status !== "failed") {
      continue;
    }
    notices.push({
      provider,
      status,
      // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- Preserve conditional fields and evaluation order.
      ...(status === "failed"
        ? {
            reason: parseProviderConnectionFailureReason(
              query[provider === "vercel" ? "vercelReason" : "githubReason"] ?? query.reason,
            ),
          }
        : {}),
    });
  }
  return notices;
}

// eslint-disable-next-line eslint/func-style -- Keep the existing declaration style.
async function loadHomeDraft(resumeKey: ReturnType<typeof parseProviderResumeKey>) {
  /* oxlint-disable typescript/strict-boolean-expressions -- Preserve empty and nullish string truthiness. */
  if (!resumeKey) {
    const pendingHandoff = await findAuthenticatedPendingBuilderHandoff({
      environment: process.env,
      headers: await headers(),
    });
    if (pendingHandoff) {
      redirect(`/handoff/${encodeURIComponent(pendingHandoff.handoffId)}`);
    }
  }
  /* oxlint-enable typescript/strict-boolean-expressions */
  /* oxlint-disable typescript/strict-boolean-expressions -- Preserve empty and nullish string truthiness. */
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
  /* oxlint-enable typescript/strict-boolean-expressions */
  return durableDraft;
}

// eslint-disable-next-line eslint/func-style -- Keep the existing declaration style.
async function loadAuthenticatedHomeData(
  user: Extract<Awaited<ReturnType<typeof currentUser>>, { status: "ready" }>,
  resumeKey: ReturnType<typeof parseProviderResumeKey>,
) {
  // oxlint-disable-next-line react-doctor/async-parallel -- Preserve flag resolution before draft lookup and its possible redirect.
  const [connectionsEnabled, comingSoonEnabled, provisioningEnabled] = await Promise.all([
    builderConnectionsFlag(),
    builderComingSoonFlag(),
    builderResourceProvisioningFlag(),
  ]);

  // oxlint-disable-next-line react-doctor/server-sequential-independent-await -- Complete the draft lookup and any redirect before loading integrations.
  const durableDraft = await loadHomeDraft(resumeKey);
  const integrations = await loadBuilderIntegrationState(
    {
      authenticated: true as const,
      environment: process.env,
      organizationId: user.user.organizationId,
      userId: user.user.id,
      workspaceId: user.user.workspaceId,
    },
    loadNextGatewayModels,
  );
  return { connectionsEnabled, comingSoonEnabled, provisioningEnabled, durableDraft, integrations };
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
async function HomeContent({ searchParams }: PageProps) {
  await connection();
  const [query, user] = await Promise.all([searchParams, currentUser()]);
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Preserve this runtime check and existing input handling.
  const mode = typeof query.mode === "string" ? query.mode : undefined;
  const notices = providerNotices(query);
  if (
    user.status === "workspace-setup-retry" ||
    user.status === "workspace-ambiguous" ||
    user.status === "access-denied"
  ) {
    return <WorkspaceOnboarding status={user.status} />;
  }

  const authenticated = user.status === "ready";
  const resumeKey = parseProviderResumeKey(query.resume);
  if (!authenticated || mode === "anonymous") {
    return <AnonymousBuilder />;
  }

  const { connectionsEnabled, comingSoonEnabled, provisioningEnabled, durableDraft, integrations } =
    await loadAuthenticatedHomeData(user, resumeKey);

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
        initialDurableDraft={durableDraft?.record.draft}
        durableDraftId={durableDraft?.draftId}
        durableDraftRevision={durableDraft?.revision}
        durableDraftUpdatedAt={durableDraft?.updatedAt}
        saveActiveBuilderDraftAction={saveActiveBuilderDraft}
        loadActiveBuilderDraftAction={loadActiveBuilderDraft}
      />
    </div>
  );
}

export default function Home(props: PageProps) {
  return (
    <RouteProviders fallback={<BuilderLoadingShell />}>
      {/* Animate navigation, not autosave updates around editable controls. */}
      <ViewTransition update="none">
        <HomeContent {...props} />
      </ViewTransition>
    </RouteProviders>
  );
}
