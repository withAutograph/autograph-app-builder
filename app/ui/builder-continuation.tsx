"use client";

import { useRouter } from "next/navigation";
import { startTransition, useActionState, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { continueBuilderHandoff } from "@/app/actions/builder";
import type {
  BuilderHandoffContinuationInput,
  BuilderHandoffContinuationState,
} from "@/app/actions/builder";
import type {
  BuilderDraftPageData,
  SaveActiveBuilderDraftInput,
} from "@/lib/builder-drafts/contracts";
import type { BuilderIntegrationState } from "@/lib/integrations/builder-state";
import type { ProviderConnectionNotice } from "@/lib/integrations/provider-connection-status";

import styles from "./app-builder.module.css";
import { Builder } from "./builder-form";
import type { BuilderDraft } from "./builder-types";

export interface AuthenticatedBuilderProps {
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
}

/** Client-only form, draft, and continuation coordination below the server shell. */
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function BuilderContinuation({
  children,
  draftStatus,
  generatedNameSeed = "app-builder",
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
}: AuthenticatedBuilderProps & { children: ReactNode; draftStatus: ReactNode }) {
  const router = useRouter();
  const [savedBrief, setSavedBrief] = useState("");
  const continuationRequest = useRef<
    | {
        draftId: string;
        intentKey: string;
        requestId: string;
        creationRequestId: string;
      }
    | undefined
  >(globalThis.undefined);
  const completedHandoff = useRef<string | undefined>(globalThis.undefined);
  const savedContinuation = useRef<BuilderHandoffContinuationInput | undefined>(
    globalThis.undefined,
  );
  const [continuation, dispatchContinuation, continuationPending] = useActionState(
    async (
      previous: BuilderHandoffContinuationState | undefined,
      input: BuilderHandoffContinuationInput,
    ): Promise<BuilderHandoffContinuationState> => {
      try {
        return await continueBuilderHandoff(previous, input);
      } catch {
        // A dropped response can follow a successful durable commit. Keep the
        // acknowledged checkpoint available for an idempotent action retry.
        return { status: "error" };
      }
    },
    globalThis.undefined,
  );

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      setSavedBrief(sessionStorage.getItem("autograph-app-brief") ?? "");
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);
  useEffect(() => {
    if (!continuation || continuationPending) {
      return;
    }
    if (continuation.status === "error") {
      return;
    }
    if (completedHandoff.current === continuation.handoff.handoffId) {
      return;
    }
    completedHandoff.current = continuation.handoff.handoffId;
    router.replace(`/handoff/${continuation.handoff.handoffId}`);
  }, [continuation, continuationPending, router]);

  // The request-fresh server draft is authoritative after provider return.
  const resumedDraft = initialDurableDraft;
  const builderKey = providerResumeKey
    ? `${providerResumeKey}:${resumedDraft ? "restored" : "missing"}`
    : savedBrief || "new";

  return (
    <>
      <Builder
        draftStatus={draftStatus}
        key={builderKey}
        initialBrief={savedBrief}
        submissionPending={continuationPending}
        generatedNameSeed={generatedNameSeed}
        initialDraft={resumedDraft}
        resumeKey={providerResumeKey}
        durableDraftId={durableDraftId}
        durableDraftRevision={durableDraftRevision}
        durableDraftUpdatedAt={durableDraftUpdatedAt}
        saveActiveBuilderDraftAction={saveActiveBuilderDraftAction}
        loadActiveBuilderDraftAction={loadActiveBuilderDraftAction}
        comingSoonEnabled={comingSoonEnabled}
        integrations={integrations}
        providerNotices={providerNotices}
        onCreate={(draftCheckpoint, intentKey) => {
          // Retrying an interrupted action reuses its durable idempotency
          // keys. A failed attempt never unmounts or resets the RHF form.
          if (
            continuationRequest.current?.draftId !== draftCheckpoint.draftId ||
            continuationRequest.current.intentKey !== intentKey
          ) {
            continuationRequest.current = {
              creationRequestId: crypto.randomUUID(),
              draftId: draftCheckpoint.draftId,
              intentKey,
              requestId: crypto.randomUUID(),
            };
          }
          const request = continuationRequest.current;
          if (!request) {
            return;
          }
          savedContinuation.current = {
            creationRequestId: request.creationRequestId,
            draftCheckpoint,
            provisioningEnabled,
            requestId: request.requestId,
            version: 1,
          };
          const input = savedContinuation.current;
          if (input) {
            startTransition(() => dispatchContinuation(input));
          }
        }}
      >
        {children}
      </Builder>
      {continuationPending ? (
        <p className={styles.draftStatus} role="status">
          Preparing your saved handoff…
        </p>
      ) : null}
      {continuation?.status === "error" && !continuationPending ? (
        <div role="alert">
          <p>We couldn’t confirm your handoff. Your saved app is still available.</p>
          <button
            type="button"
            onClick={() => {
              const input = savedContinuation.current;
              if (input) {
                startTransition(() => dispatchContinuation(input));
              }
            }}
          >
            Retry saved handoff
          </button>
        </div>
      ) : null}
    </>
  );
}
