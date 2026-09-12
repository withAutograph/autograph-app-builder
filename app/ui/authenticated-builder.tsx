"use client";

import { useRouter } from "next/navigation";
import { startTransition, useActionState, useEffect, useRef, useState } from "react";

import { continueBuilderHandoff } from "@/app/actions/builder";
import type {
  BuilderDraftPageData,
  SaveActiveBuilderDraftInput,
} from "@/lib/builder-drafts/contracts";
import type { BuilderIntegrationState } from "@/lib/integrations/builder-state";
import type { ProviderConnectionNotice } from "@/lib/integrations/provider-connection-status";

import styles from "./app-builder.module.css";
import { Builder } from "./app-builder";
import type { BuilderDraft } from "./builder-types";

export type AuthenticatedBuilderProps = {
  generatedNameSeed?: string;
  connectionsEnabled?: boolean;
  comingSoonEnabled?: boolean;
  provisioningEnabled?: boolean;
  integrations: BuilderIntegrationState;
  providerNotices?: ProviderConnectionNotice[];
  providerResumeKey?: string;
  initialDurableDraft?: BuilderDraft;
  durableDraftId?: string;
  durableDraftRevision?: number;
  durableDraftUpdatedAt?: string;
  saveActiveBuilderDraftAction?: (
    input: SaveActiveBuilderDraftInput,
  ) => Promise<{ draftId: string; revision: number; updatedAt: string }>;
  loadActiveBuilderDraftAction?: () => Promise<BuilderDraftPageData | undefined>;
  clearBuilderDraftAction?: (draftId: string) => Promise<unknown>;
};

/** Client-only form, draft, and continuation coordination below the server shell. */
export function AuthenticatedBuilder({
  generatedNameSeed = "app-builder",
  connectionsEnabled = false,
  comingSoonEnabled = false,
  provisioningEnabled = false,
  integrations,
  providerNotices = [],
  providerResumeKey,
  initialDurableDraft,
  durableDraftId,
  durableDraftRevision,
  durableDraftUpdatedAt,
  saveActiveBuilderDraftAction,
  loadActiveBuilderDraftAction,
  clearBuilderDraftAction,
}: AuthenticatedBuilderProps) {
  const router = useRouter();
  const [savedBrief, setSavedBrief] = useState("");
  const activeDraftId = useRef<string | undefined>(undefined);
  const completedHandoff = useRef<string | undefined>(undefined);
  const [continuation, dispatchContinuation, continuationPending] = useActionState(
    continueBuilderHandoff,
    undefined,
  );

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      setSavedBrief(sessionStorage.getItem("autograph-app-brief") ?? "");
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);
  useEffect(() => {
    if (!continuation || continuationPending) return;
    if (continuation.status === "error") return;
    if (completedHandoff.current === continuation.handoff.handoffId) return;
    completedHandoff.current = continuation.handoff.handoffId;
    if (activeDraftId.current) void clearBuilderDraftAction?.(activeDraftId.current);
    router.replace(`/handoff/${continuation.handoff.handoffId}`);
  }, [clearBuilderDraftAction, continuation, continuationPending, router]);

  // The request-fresh server draft is authoritative after provider return.
  const resumedDraft = initialDurableDraft;
  const builderKey = providerResumeKey
    ? `${providerResumeKey}:${resumedDraft ? "restored" : "missing"}`
    : savedBrief || "new";

  return (
    <>
      {continuationPending ? (
        <main className={styles.flowPage} id="main-content">
          <section className={styles.readyCard} aria-busy="true">
            <h1>Preparing your handoff</h1>
            <p>Your saved app is being prepared.</p>
          </section>
        </main>
      ) : (
        <Builder
          key={builderKey}
          initialBrief={savedBrief}
          generatedNameSeed={generatedNameSeed}
          initialDraft={resumedDraft}
          resumeKey={providerResumeKey}
          durableDraftId={durableDraftId}
          durableDraftRevision={durableDraftRevision}
          durableDraftUpdatedAt={durableDraftUpdatedAt}
          saveActiveBuilderDraftAction={saveActiveBuilderDraftAction}
          loadActiveBuilderDraftAction={loadActiveBuilderDraftAction}
          connectionsEnabled={connectionsEnabled}
          comingSoonEnabled={comingSoonEnabled}
          integrations={integrations}
          providerNotices={providerNotices}
          onCreate={(form, draftId) => {
            activeDraftId.current = draftId ?? durableDraftId;
            startTransition(() =>
              dispatchContinuation({
                version: 1,
                requestId: crypto.randomUUID(),
                creationRequestId: crypto.randomUUID(),
                provisioningEnabled,
                form,
              }),
            );
          }}
        />
      )}
      {continuation?.status === "error" && !continuationPending ? (
        <p role="alert">We couldn’t prepare your handoff. Your saved draft is still available.</p>
      ) : null}
    </>
  );
}
