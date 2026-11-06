"use client";

import {
  startTransition,
  useActionState,
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
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

const handoffControlSchema = z
  .strictObject({
    cursorInstallReady: z.boolean(),
    destination: z.enum(["codex", "cursor"]),
    expiresAt: z.iso.datetime(),
    handoffId: z.string(),
    mcpUrl: z.url(),
    status: z.enum(["prepared", "continued", "expired"]),
    version: z.literal(1),
  })
  .strict();

const subscribeToClientSnapshot = () => () => {
  // Hydration readiness has no external subscription.
};

type Access = "ready" | "sign-in" | "unavailable";
interface UiState {
  access: Access;
  data: HandoffControlData;
  notice: string;
}
type UiAction =
  | { type: "access"; access: Access }
  | { type: "data"; data: HandoffControlData }
  | { type: "notice"; notice: string };
const reduceUiState = (state: UiState, action: UiAction): UiState => {
  switch (action.type) {
    case "access": {
      return { ...state, access: action.access };
    }
    case "data": {
      return { ...state, data: action.data };
    }
    case "notice": {
      return { ...state, notice: action.notice };
    }
    default: {
      return state;
    }
  }
};

const useHandoffStatus = ({
  access,
  handoffId,
  onAccess,
  onData,
  onNotice,
  renewalPending,
  status,
}: PollingProps) => {
  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    let refreshing = false;
    if (access !== "ready" || renewalPending || status === "continued") {
      return () => {
        disposed = true;
        controller.abort();
      };
    }
    const refresh = async (): Promise<void> => {
      if (disposed || refreshing || document.visibilityState !== "visible") {
        return;
      }
      refreshing = true;
      try {
        const response = await fetch(`/api/builder/handoffs/${encodeURIComponent(handoffId)}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (controller.signal.aborted || disposed) {
          return;
        }
        if ([401, 403, 404].includes(response.status)) {
          onAccess(response.status === 401 ? "sign-in" : "unavailable");
          return;
        }
        if (!response.ok) {
          throw new Error("handoff-status-unavailable");
        }
        const parsed = handoffControlSchema.safeParse(await response.json());
        if (!parsed.success || parsed.data.handoffId !== handoffId) {
          throw new Error("handoff-response-invalid");
        }
        const next = parsed.data;
        onData(next);
        onNotice("");
        if (next.status === "continued") {
          return;
        }
      } catch {
        if (!controller.signal.aborted && !disposed) {
          onNotice(
            "Status is temporarily unavailable. Your prepared app is saved; we’ll retry while this page is open.",
          );
        }
      }
      refreshing = false;
    };
    const visibilityChanged = () => {
      if (document.visibilityState === "visible") {
        void refresh();
      }
    };
    const timer = setInterval(() => {
      void refresh();
    }, 5000);
    document.addEventListener("visibilitychange", visibilityChanged);
    void refresh();
    return () => {
      disposed = true;
      clearInterval(timer);
      controller.abort();
      document.removeEventListener("visibilitychange", visibilityChanged);
    };
  }, [access, handoffId, onAccess, onData, onNotice, renewalPending, status]);
};

const renderCursorSetupLink = (destination: string, url?: string) => {
  if (destination !== "cursor") {
    return null;
  }
  if (url !== undefined && url.length > 0) {
    return <a href={url}>Add Autograph to Cursor</a>;
  }
  return <p>Cursor connection setup is not available yet.</p>;
};

interface PollingProps {
  access: "ready" | "sign-in" | "unavailable";
  handoffId: string;
  onAccess: (access: "ready" | "sign-in" | "unavailable") => void;
  onData: (data: HandoffControlData) => void;
  onNotice: (notice: string) => void;
  renewalPending: boolean;
  status: HandoffControlData["status"];
}

const HandoffControlsView = ({
  access,
  copyNotice,
  data,
  destination,
  disabled,
  installUrl,
  label,
  launchNotice,
  notice,
  onCopyNotice,
  onDestination,
  onLaunchNotice,
  onRenew,
  prompt,
  renewalNotice,
  renewalPending,
  signInUrl,
  status,
}: {
  access: Access;
  copyNotice: string;
  data: HandoffControlData;
  destination: HandoffControlData["destination"];
  disabled: boolean;
  installUrl?: string;
  label: string;
  launchNotice: string;
  notice: string;
  onCopyNotice: (notice: string) => void;
  onDestination: (destination: HandoffControlData["destination"]) => void;
  onLaunchNotice: (notice: string) => void;
  onRenew: () => void;
  prompt: string;
  renewalNotice: string;
  renewalPending: boolean;
  signInUrl: string;
  status: HandoffControlData["status"];
}) => {
  let statusMessage =
    "Your app is prepared. Open your client, then review and send the prompt to continue.";
  if (status === "expired") {
    statusMessage =
      "This handoff has expired. Renew it to continue with your saved brief and resources.";
  }
  if (status === "continued") {
    statusMessage = "Continued in your app. You can reopen this handoff in either client.";
  }
  if (access === "unavailable") {
    statusMessage =
      "This handoff is unavailable. Use the same Autograph account and workspace as the web form.";
  }
  if (access === "sign-in") {
    statusMessage = "Sign in to continue your saved app.";
  }
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(prompt);
      onCopyNotice("Prompt copied.");
    } catch {
      onCopyNotice("Copy failed. Select and copy the prompt below manually.");
    }
  };

  return (
    <>
      <section aria-label="Continue your app" className={handoffStyles.controls}>
        <p role="status" aria-live="polite" className={styles.continueStatus}>
          {statusMessage}
        </p>
        {access === "ready" ? null : <a href={signInUrl}>Sign in with the same account</a>}
        <fieldset disabled={renewalPending}>
          <legend>Continue in</legend>
          {(["codex", "cursor"] as const).map((choice) => (
            <label key={choice}>
              <input
                type="radio"
                name="handoff-destination"
                value={choice}
                checked={destination === choice}
                onChange={() => {
                  onDestination(choice);
                  onLaunchNotice("");
                  onCopyNotice("");
                }}
              />
              {choice === "codex" ? "Codex" : "Cursor"}
            </label>
          ))}
        </fieldset>
        {status === "expired" && access === "ready" ? (
          <button
            className={styles.createButton}
            type="button"
            disabled={renewalPending}
            onClick={onRenew}
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
              onLaunchNotice(
                `Launch requested for ${label}. If it did not open, try again or paste the prompt manually. Review and send it in ${label}.`,
              );
            } catch {
              onLaunchNotice(
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
                void onCopy();
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
    </>
  );
};

const HandoffControls = ({ initial }: { initial: HandoffControlData }) => {
  // The instant server shell is visible before browser event handlers exist.
  // Do not expose an enabled action that can silently discard that first click.
  const isClientReady = useSyncExternalStore(
    subscribeToClientSnapshot,
    () => true,
    () => false,
  );
  const [ui, dispatchUi] = useReducer(reduceUiState, {
    access: "ready",
    data: initial,
    notice: "",
  });
  const { notice } = ui;
  const [destination, setDestination] = useState(initial.destination);
  const [launchNotice, setLaunchNotice] = useState("");
  const [copyNotice, setCopyNotice] = useState("");
  const renewalRequest = useRef<{ handoffId: string; id: string } | undefined>();
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
  const data =
    renewal?.status === "renewed" && renewal.handoff.handoffId === ui.data.handoffId
      ? renewal.handoff
      : ui.data;
  const access =
    renewal?.status === "sign-in" || renewal?.status === "unavailable" ? renewal.status : ui.access;
  useEffect(() => {
    if (renewal?.status === "renewed" && renewal.handoff.handoffId !== ui.data.handoffId) {
      window.location.replace(`/handoff/${encodeURIComponent(renewal.handoff.handoffId)}`);
    }
  }, [renewal, ui.data.handoffId]);
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
        /* Session storage is optional. */
      }
      const id = saved !== null && /^[0-9a-f-]{36}$/iu.test(saved) ? saved : crypto.randomUUID();
      renewalRequest.current = { handoffId: data.handoffId, id };
      try {
        sessionStorage.setItem(storageKey, id);
      } catch {
        /* Session storage is optional. */
      }
    }
    const request = renewalRequest.current;
    if (request === undefined) {
      return;
    }
    startTransition(() => {
      dispatchRenewal({ creationRequestId: request.id, handoffId: data.handoffId });
    });
  };
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

  useHandoffStatus({
    access,
    handoffId: data.handoffId,
    onAccess: (next) => {
      dispatchUi({ access: next, type: "access" });
    },
    onData: (next) => {
      dispatchUi({ data: next, type: "data" });
    },
    onNotice: (next) => {
      dispatchUi({ notice: next, type: "notice" });
    },
    renewalPending,
    status: data.status,
  });

  return (
    <HandoffControlsView
      access={access}
      copyNotice={copyNotice}
      data={data}
      destination={destination}
      disabled={disabled}
      installUrl={installUrl}
      label={label}
      launchNotice={launchNotice}
      notice={notice}
      onCopyNotice={setCopyNotice}
      onDestination={setDestination}
      onLaunchNotice={setLaunchNotice}
      onRenew={renew}
      prompt={prompt}
      renewalNotice={
        renewal?.status === "error"
          ? "We couldn’t renew this handoff. Try again; your brief and completed resources are saved."
          : ""
      }
      renewalPending={renewalPending}
      signInUrl={signInUrl}
      status={data.status}
    />
  );
};

export { HandoffControls };
