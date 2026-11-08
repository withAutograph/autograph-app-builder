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
import { useRouter } from "next/navigation";

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

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function readStatus(value: HandoffControlData, handoffId: string): HandoffControlData {
  if (
    // oxlint-disable-next-line sonarjs/expression-complexity -- Preserve the existing conditions and their evaluation order.
    value.version !== 1 ||
    value.handoffId !== handoffId ||
    !["prepared", "continued", "expired"].includes(value.status) ||
    !["codex", "cursor"].includes(value.destination) ||
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Preserve this runtime check and existing input handling.
    typeof value.cursorInstallReady !== "boolean" ||
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Preserve this runtime check and existing input handling.
    typeof value.mcpUrl !== "string" ||
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Preserve this runtime check and existing input handling.
    typeof value.expiresAt !== "string" ||
    Number.isNaN(Date.parse(value.expiresAt))
  ) {
    throw new Error("handoff-response-invalid");
  }
  return {
    cursorInstallReady: value.cursorInstallReady,
    destination: value.destination,
    expiresAt: value.expiresAt,
    handoffId,
    mcpUrl: value.mcpUrl,
    status: value.status,
    version: 1,
  };
}

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
  if (url) {
    return <a href={url}>Add Autograph to Cursor</a>;
  }
  return <p>Cursor connection setup is not available yet.</p>;
};

type HandoffAccess = "ready" | "sign-in" | "unavailable";

interface HandoffViewState {
  data: HandoffControlData;
  access: HandoffAccess;
  renewalNotice: string;
}

type HandoffViewAction =
  | { type: "status"; data: HandoffControlData }
  | { type: "access"; access: HandoffAccess }
  | { type: "renewal"; result: HandoffRenewalActionState; currentHandoffId: string }
  | { type: "clear-renewal-notice" };

const handoffViewReducer = (
  state: HandoffViewState,
  action: HandoffViewAction,
): HandoffViewState => {
  if (action.type === "status") {
    return { ...state, data: action.data };
  }
  if (action.type === "access") {
    return { ...state, access: action.access };
  }
  if (action.type === "clear-renewal-notice") {
    return { ...state, renewalNotice: "" };
  }
  if (action.result.status === "sign-in" || action.result.status === "unavailable") {
    return { ...state, access: action.result.status };
  }
  if (action.result.status === "error") {
    return {
      ...state,
      renewalNotice:
        "We couldn’t renew this handoff. Try again; your brief and completed resources are saved.",
    };
  }
  return {
    ...state,
    data:
      action.result.handoff.handoffId === action.currentHandoffId
        ? action.result.handoff
        : state.data,
    renewalNotice: "",
  };
};

const createHandoffViewStore = (initial: HandoffControlData) => {
  let state: HandoffViewState = { data: initial, access: "ready", renewalNotice: "" };
  const initialState = state;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => state,
    getServerSnapshot: () => initialState,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispatch: (action: HandoffViewAction) => {
      state = handoffViewReducer(state, action);
      for (const listener of listeners) {
        listener();
      }
    },
  };
};

const subscribeToHandoffStatus = (
  handoffId: string,
  onStatus: (status: HandoffControlData) => void,
  onAccess: (access: HandoffAccess) => void,
  onNotice: (notice: string) => void,
) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  let disposed = false;
  const stop = () => {
    clearTimeout(timer);
    controller?.abort();
  };
  const refresh = async () => {
    if (disposed || document.visibilityState !== "visible") {
      return;
    }
    const request = new AbortController();
    controller = request;
    let complete = false;
    try {
      const response = await fetch(`/api/builder/handoffs/${encodeURIComponent(handoffId)}`, {
        cache: "no-store",
        signal: request.signal,
      });
      if (request.signal.aborted || disposed) {
        return;
      }
      if (response.status === 401 || response.status === 403 || response.status === 404) {
        complete = true;
        onAccess(response.status === 401 ? "sign-in" : "unavailable");
        return;
      }
      if (!response.ok) {
        throw new Error("handoff-status-unavailable");
      }
      // oxlint-disable-next-line typescript/no-unsafe-argument -- Pass the response body to the existing status parser.
      const next = readStatus(await response.json(), handoffId);
      if (request.signal.aborted || disposed) {
        return;
      }
      complete = next.status === "continued";
      onStatus(next);
    } catch {
      if (!request.signal.aborted && !disposed) {
        onNotice(
          "Status is temporarily unavailable. Your prepared app is saved; we’ll retry while this page is open.",
        );
      }
    } finally {
      if (
        !disposed &&
        !request.signal.aborted &&
        !complete &&
        document.visibilityState === "visible"
      ) {
        timer = setTimeout(() => {
          void refresh();
        }, 5000);
      }
    }
  };
  const visibilityChanged = () => {
    stop();
    if (document.visibilityState === "visible") {
      void refresh();
    }
  };
  document.addEventListener("visibilitychange", visibilityChanged);
  void refresh();
  return () => {
    disposed = true;
    clearTimeout(timer);
    controller?.abort();
    document.removeEventListener("visibilitychange", visibilityChanged);
  };
};

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting.
export function HandoffControls({ initial }: { initial: HandoffControlData }) {
  // The instant server shell is visible before browser event handlers exist.
  // Do not expose an enabled action that can silently discard that first click.
  const isClientReady = useSyncExternalStore(
    subscribeToClientSnapshot,
    () => true,
    () => false,
  );
  const router = useRouter();
  const [handoffStore] = useState(() => createHandoffViewStore(initial));
  const dispatchHandoffView = handoffStore.dispatch;
  const [destination, setDestination] = useState(initial.destination);
  const [notice, setNotice] = useState("");
  const [launchNotice, setLaunchNotice] = useState("");
  const [copyNotice, setCopyNotice] = useState("");
  // oxlint-disable-next-line unicorn/no-useless-undefined -- React requires an initial value for this optional request ref.
  const renewalRequest = useRef<{ handoffId: string; id: string } | undefined>(undefined);
  // oxlint-disable-next-line unicorn/no-useless-undefined -- React requires an initial value for this optional reconciliation ref.
  const reconciledRenewal = useRef<HandoffRenewalActionState | undefined>(undefined);
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
  // oxlint-disable-next-line unicorn/no-useless-undefined -- The renewal action explicitly starts without a result.
  const [renewal, dispatchRenewal, renewalPending] = useActionState(runRenewalAction, undefined);
  const subscribeHandoff = useCallback(
    (listener: () => void) => {
      let stopPolling: (() => void) | undefined;
      let activeKey: string | undefined;
      const updateSubscription = () => {
        const current = handoffStore.getSnapshot();
        const nextKey =
          current.access === "ready" && !renewalPending && current.data.status !== "continued"
            ? `${current.data.handoffId}:${current.data.status}`
            : undefined;
        if (activeKey === nextKey) {
          return;
        }
        stopPolling?.();
        // oxlint-disable-next-line sonarjs/no-undefined-assignment -- Preserve the existing explicit undefined value.
        stopPolling = undefined;
        activeKey = nextKey;
        if (nextKey !== undefined) {
          stopPolling = subscribeToHandoffStatus(
            current.data.handoffId,
            (next) => {
              dispatchHandoffView({ type: "status", data: next });
              setNotice("");
            },
            (next) => {
              dispatchHandoffView({ type: "access", access: next });
            },
            setNotice,
          );
        }
      };
      const unsubscribe = handoffStore.subscribe(() => {
        updateSubscription();
        listener();
      });
      updateSubscription();
      return () => {
        unsubscribe();
        stopPolling?.();
      };
    },
    [handoffStore, dispatchHandoffView, renewalPending],
  );
  const { data, access, renewalNotice } = useSyncExternalStore(
    subscribeHandoff,
    handoffStore.getSnapshot,
    handoffStore.getServerSnapshot,
  );
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
    if (renewal.status === "renewed") {
      buildAppHandoffPrompt(renewal.handoff.handoffId, destination);
    }
    dispatchHandoffView({ type: "renewal", result: renewal, currentHandoffId: data.handoffId });
    if (renewal.status === "renewed" && renewal.handoff.handoffId !== data.handoffId) {
      // oxlint-disable-next-line react-doctor/nextjs-no-client-side-redirect -- Follow the replacement handoff only after renewal succeeds.
      router.replace(`/handoff/${encodeURIComponent(renewal.handoff.handoffId)}`);
    }
  }, [data.handoffId, destination, renewal, renewalPending, router]);

  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopyNotice("Prompt copied.");
    } catch {
      setCopyNotice("Copy failed. Select and copy the prompt below manually.");
    }
  };

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
      const id = saved && /^[0-9a-f-]{36}$/iu.test(saved) ? saved : crypto.randomUUID();
      renewalRequest.current = { handoffId: data.handoffId, id };
      try {
        sessionStorage.setItem(storageKey, id);
      } catch {
        // Session storage is optional.
      }
    }
    dispatchHandoffView({ type: "clear-renewal-notice" });
    const request = renewalRequest.current;
    if (!request) {
      return;
    }
    startTransition(
      dispatchRenewal.bind(null, {
        creationRequestId: request.id,
        handoffId: data.handoffId,
      }),
    );
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
              void copyPrompt();
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
}
