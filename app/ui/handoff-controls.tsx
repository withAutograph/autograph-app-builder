"use client";

import {
  startTransition,
  useActionState,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";

import { renewBuilderHandoff } from "@/app/actions/handoff-renewal";
import type { HandoffControlData, HandoffRenewalActionState } from "@/app/actions/handoff-renewal";
import {
  buildAppHandoffPrompt,
  buildAppHandoffUrl,
  buildCursorInstallUrl,
} from "../../lib/handoff/client";
import styles from "./app-builder.module.css";
import handoffStyles from "./handoff.module.css";

export type { HandoffControlData } from "@/app/actions/handoff-renewal";

const handoffStatusSchema = z.object({
  cursorInstallReady: z.boolean(),
  destination: z.enum(["codex", "cursor"]),
  expiresAt: z.string(),
  handoffId: z.string(),
  mcpUrl: z.string(),
  status: z.enum(["prepared", "continued", "expired"]),
  version: z.literal(1),
});

const useHandoffStatus = (initial: HandoffControlData, enabled: boolean) =>
  useQuery({
    enabled,
    queryFn: async ({ signal }): Promise<HandoffControlData> => {
      const response = await fetch(
        `/api/builder/handoffs/${encodeURIComponent(initial.handoffId)}`,
        {
          cache: "no-store",
          signal,
        },
      );
      if (response.status === 401 || response.status === 403 || response.status === 404) {
        throw new Error(`handoff-access-${response.status}`);
      }
      if (!response.ok) {
        throw new Error("handoff-status-unavailable");
      }
      const value: HandoffControlData = handoffStatusSchema.parse(await response.json());
      if (value.handoffId !== initial.handoffId || Number.isNaN(Date.parse(value.expiresAt))) {
        throw new Error("handoff-response-invalid");
      }
      return value;
    },
    queryKey: ["builder-handoff", initial.handoffId],
    refetchInterval: (query) => (query.state.data?.status === "continued" ? false : 5000),
    refetchIntervalInBackground: false,
  });

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function subscribeToClientSnapshot() {
  return () => {
    // Hydration readiness has no external subscription.
  };
}

const renderCursorSetupLink = (destination: string, url?: string) => {
  if (destination !== "cursor") {
    return null;
  }
  if (url !== undefined && url.length > 0) {
    return <a href={url}>Add Autograph to Cursor</a>;
  }
  return <p>Cursor connection setup is not available yet.</p>;
};

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting.
export const HandoffControls = ({ initial }: { initial: HandoffControlData }) => {
  const [queryClient] = useState(() => new QueryClient());
  return (
    <QueryClientProvider client={queryClient}>
      <HandoffControlsContent initial={initial} />
    </QueryClientProvider>
  );
};

const HandoffControlsContent = ({ initial }: { initial: HandoffControlData }) => {
  // The instant server shell is visible before browser event handlers exist.
  // Do not expose an enabled action that can silently discard that first click.
  const isClientReady = useSyncExternalStore(
    subscribeToClientSnapshot,
    () => true,
    () => false,
  );
  const [destination, setDestination] = useState(initial.destination);
  const [renewalNotice, setRenewalNotice] = useState("");
  const [launchNotice, setLaunchNotice] = useState("");
  const [copyNotice, setCopyNotice] = useState("");
  const renewalRequest = useRef<{ handoffId: string; id: string } | undefined>();
  const reconciledRenewal = useRef<HandoffRenewalActionState | undefined>();
  const runRenewalAction = useCallback(
    async (
      previous: HandoffRenewalActionState | undefined,
      input: Parameters<typeof renewBuilderHandoff>[1],
    ): Promise<HandoffRenewalActionState> => {
      try {
        return await renewBuilderHandoff(previous, input);
      } catch {
        // Server Action transport failures belong in the same retryable UI as typed failures.
        return { status: "error" };
      }
    },
    [],
  );
  const [renewal, dispatchRenewal, renewalPending] = useActionState(runRenewalAction);
  const queryClient = useQueryClient();
  const statusQuery = useHandoffStatus(
    initial,
    isClientReady && !renewalPending && initial.status !== "continued",
  );
  const data =
    renewal?.status === "renewed" && renewal.handoff.handoffId === initial.handoffId
      ? renewal.handoff
      : (statusQuery.data ?? initial);
  const denied =
    statusQuery.error instanceof Error && statusQuery.error.message.startsWith("handoff-access-");
  const access =
    renewal?.status === "sign-in" || (denied && statusQuery.error?.message === "handoff-access-401")
      ? "sign-in"
      : renewal?.status === "unavailable" || denied
        ? "unavailable"
        : "ready";
  const notice =
    statusQuery.error !== null && statusQuery.error !== undefined && !denied
      ? "Status is temporarily unavailable. Your prepared app is saved; we’ll retry while this page is open."
      : "";
  const handoffPath = `/handoff/${encodeURIComponent(data.handoffId)}`;
  const signInUrl = `/auth/sign-in?callbackURL=${encodeURIComponent(handoffPath)}`;
  const label = destination === "codex" ? "Codex" : "Cursor";
  const prompt = buildAppHandoffPrompt(data.handoffId, destination);
  const disabled =
    !isClientReady || access !== "ready" || data.status === "expired" || renewalPending;
  const installUrl =
    destination === "cursor" && access === "ready"
      ? buildCursorInstallUrl(data.mcpUrl, data.cursorInstallReady)
      : undefined;

  useEffect(() => {
    if (!renewal || renewalPending || reconciledRenewal.current === renewal) {
      return;
    }
    reconciledRenewal.current = renewal;
    if (renewal.status === "sign-in") {
      return;
    }
    if (renewal.status === "unavailable") {
      return;
    }
    if (renewal.status === "error") {
      setRenewalNotice(
        "We couldn’t renew this handoff. Try again; your brief and completed resources are saved.",
      );
      return;
    }
    setRenewalNotice("");
    if (renewal.handoff.handoffId === data.handoffId) {
      queryClient.setQueryData(["builder-handoff", data.handoffId], renewal.handoff);
    } else {
      window.location.replace(`/handoff/${encodeURIComponent(renewal.handoff.handoffId)}`);
    }
  }, [data.handoffId, queryClient, renewal, renewalPending]);

  const renew = () => {
    if (!isClientReady || renewalPending || access !== "ready") {
      return;
    }
    const storageKey = `autograph-handoff-renew:${data.handoffId}`;
    if (renewalRequest.current?.handoffId !== data.handoffId) {
      let saved: string | null = null;
      try {
        saved = sessionStorage.getItem(storageKey);
      } catch {
        // Session storage is optional.
      }
      const id = saved !== null && /^[0-9a-f-]{36}$/iu.test(saved) ? saved : crypto.randomUUID();
      renewalRequest.current = { handoffId: data.handoffId, id };
      try {
        sessionStorage.setItem(storageKey, id);
      } catch {
        // Session storage is optional.
      }
    }
    setRenewalNotice("");
    const request = renewalRequest.current;
    if (!request) {
      return;
    }
    startTransition(() => {
      dispatchRenewal({
        creationRequestId: request.id,
        handoffId: data.handoffId,
      });
    });
  };

  let statusMessage =
    "Your app is prepared. Open your client, then review and send the prompt to continue.";
  if (data.status === "expired") {
    statusMessage =
      "This handoff has expired. Renew it to continue with your saved brief and resources.";
  }
  if (data.status === "continued") {
    statusMessage = "Continued in your app. You can reopen this handoff in either client.";
  }
  if (access === "unavailable") {
    statusMessage =
      "This handoff is unavailable. Use the same Autograph account and workspace as the web form.";
  }
  if (access === "sign-in") {
    statusMessage = "Sign in to continue your saved app.";
  }

  return (
    <section aria-label="Continue your app" className={handoffStyles.controls}>
      <p role="status" aria-live="polite" className={styles.continueStatus}>
        {statusMessage}
      </p>
      {access === "ready" ? null : <a href={signInUrl}>Sign in with the same account</a>}
      <fieldset disabled={!isClientReady || renewalPending}>
        <legend>Continue in</legend>
        {(["codex", "cursor"] as const).map((choice) => (
          <label key={choice}>
            <input
              type="radio"
              name="handoff-destination"
              value={choice}
              checked={destination === choice}
              onChange={() => {
                setDestination(choice);
                setLaunchNotice("");
                setCopyNotice("");
              }}
            />
            {choice === "codex" ? "Codex" : "Cursor"}
          </label>
        ))}
      </fieldset>
      {data.status === "expired" && access === "ready" ? (
        <button
          className={styles.createButton}
          type="button"
          disabled={!isClientReady || renewalPending}
          onClick={renew}
        >
          {renewalPending ? "Renewing…" : "Renew handoff"}
        </button>
      ) : null}
      <button
        className={styles.createButton}
        type="button"
        disabled={disabled}
        onClick={() => {
          try {
            window.open(
              buildAppHandoffUrl(destination, data.handoffId),
              "_blank",
              "noopener,noreferrer",
            );
            setLaunchNotice(
              `Launch requested for ${label}. If it did not open, try again or paste the prompt manually. Review and send it in ${label}.`,
            );
          } catch {
            setLaunchNotice(
              `The browser blocked ${label}. Open it manually and paste the prompt below.`,
            );
          }
        }}
      >
        Open in {label}
      </button>
      <p role="status" aria-live="polite">
        {launchNotice}
      </p>
      {access === "ready" ? (
        <>
          <button
            className={handoffStyles.secondaryButton}
            type="button"
            disabled={disabled}
            onClick={() => {
              void navigator.clipboard.writeText(prompt).then(
                () => {
                  setCopyNotice("Prompt copied.");
                },
                () => {
                  setCopyNotice("Copy failed. Select and copy the prompt below manually.");
                },
              );
            }}
          >
            Copy prompt
          </button>
          <p role="status" aria-live="polite">
            {copyNotice}
          </p>
          <details>
            <summary>View prompt for manual copy</summary>
            <textarea
              aria-label="Handoff prompt"
              readOnly
              value={prompt}
              rows={12}
              style={{ width: "100%" }}
            />
          </details>
          <details>
            <summary>Set up Autograph in {label}</summary>
            <p>
              Autograph will help {label} connect and continue your saved app. If asked, sign in
              with the same Autograph account and approve the connection.
            </p>
            {renderCursorSetupLink(destination, installUrl)}
            <p>
              Builder connection address: <code>{data.mcpUrl}</code>
            </p>
          </details>
        </>
      ) : null}
      {notice ? <p role="alert">{notice}</p> : null}
      {renewalNotice ? <p role="alert">{renewalNotice}</p> : null}
    </section>
  );
};
