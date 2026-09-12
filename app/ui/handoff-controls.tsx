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
  codexInstallCommand,
} from "../../lib/handoff/client";
import styles from "./app-builder.module.css";
import handoffStyles from "./handoff.module.css";

export type { HandoffControlData } from "@/app/actions/handoff-renewal";

function readStatus(value: HandoffControlData, handoffId: string): HandoffControlData {
  if (
    value.version !== 1 ||
    value.handoffId !== handoffId ||
    !["prepared", "continued", "expired"].includes(value.status) ||
    !["codex", "cursor"].includes(value.destination) ||
    typeof value.cursorInstallReady !== "boolean" ||
    typeof value.mcpUrl !== "string" ||
    typeof value.expiresAt !== "string" ||
    Number.isNaN(Date.parse(value.expiresAt))
  ) {
    throw new Error("handoff-response-invalid");
  }
  return {
    version: 1,
    handoffId,
    expiresAt: value.expiresAt,
    status: value.status,
    destination: value.destination,
    cursorInstallReady: value.cursorInstallReady,
    mcpUrl: value.mcpUrl,
  };
}

function subscribeToClientSnapshot() {
  return () => {
    // Hydration readiness has no external subscription.
  };
}

export function HandoffControls({ initial }: { initial: HandoffControlData }) {
  // The instant server shell is visible before browser event handlers exist.
  // Do not expose an enabled action that can silently discard that first click.
  const isClientReady = useSyncExternalStore(
    subscribeToClientSnapshot,
    () => true,
    () => false,
  );
  const router = useRouter();
  const [data, setData] = useState(initial);
  const [destination, setDestination] = useState(initial.destination);
  const [notice, setNotice] = useState("");
  const [renewalNotice, setRenewalNotice] = useState("");
  const [launchNotice, setLaunchNotice] = useState("");
  const [copyNotice, setCopyNotice] = useState("");
  const [access, setAccess] = useState<"ready" | "sign-in" | "unavailable">("ready");
  const renewalRequest = useRef<{ handoffId: string; id: string } | undefined>(undefined);
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
  const [renewal, dispatchRenewal, renewalPending] = useActionState(runRenewalAction, undefined);
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
    if (access !== "ready" || renewalPending || data.status === "continued") {
      return;
    }
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
        const response = await fetch(
          `/api/builder/handoffs/${encodeURIComponent(data.handoffId)}`,
          {
            cache: "no-store",
            signal: request.signal,
          },
        );
        if (request.signal.aborted || disposed) {
          return;
        }
        if (response.status === 401 || response.status === 403 || response.status === 404) {
          complete = true;
          setAccess(response.status === 401 ? "sign-in" : "unavailable");
          return;
        }
        if (!response.ok) {
          throw new Error("handoff-status-unavailable");
        }
        const next = readStatus(await response.json(), data.handoffId);
        if (request.signal.aborted || disposed) {
          return;
        }
        complete = next.status === "continued";
        setData(next);
        setNotice("");
      } catch {
        if (!request.signal.aborted && !disposed) {
          setNotice(
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
            refresh();
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
  }, [access, data.handoffId, data.status, renewalPending]);

  useEffect(() => {
    if (!renewal || renewalPending || reconciledRenewal.current === renewal) {
      return;
    }
    reconciledRenewal.current = renewal;
    if (renewal.status === "sign-in") {
      setAccess("sign-in");
      return;
    }
    if (renewal.status === "unavailable") {
      setAccess("unavailable");
      return;
    }
    if (renewal.status === "error") {
      setRenewalNotice(
        "We couldn’t renew this handoff. Try again; your brief and completed resources are saved.",
      );
      return;
    }
    setRenewalNotice("");
    buildAppHandoffPrompt(renewal.handoff.handoffId, destination);
    if (renewal.handoff.handoffId === data.handoffId) {
      setData(renewal.handoff);
    } else {
      router.replace(`/handoff/${encodeURIComponent(renewal.handoff.handoffId)}`);
    }
  }, [data.handoffId, destination, renewal, renewalPending, router]);

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
    setRenewalNotice("");
    startTransition(() =>
      dispatchRenewal({
        handoffId: data.handoffId,
        creationRequestId: renewalRequest.current!.id,
      }),
    );
  };

  return (
    <section aria-label="Continue your app" className={handoffStyles.controls}>
      <p role="status" aria-live="polite" className={styles.continueStatus}>
        {access === "sign-in"
          ? "Sign in to continue your saved app."
          : access === "unavailable"
            ? "This handoff is unavailable. Use the same Autograph account and workspace as the web form."
            : data.status === "continued"
              ? "Continued in your app. You can reopen this handoff in either client."
              : data.status === "expired"
                ? "This handoff has expired. Renew it to continue with your saved brief and resources."
                : "Your app is prepared. Open your client, then review and send the prompt to continue."}
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
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(prompt);
                setCopyNotice("Prompt copied.");
              } catch {
                setCopyNotice("Copy failed. Select and copy the prompt below manually.");
              }
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
              Connect Autograph using the same account and browser profile as this form. A new
              client may ask you to allow Autograph once. Your saved GitHub and Vercel connections
              are reused.
            </p>
            {destination === "codex" ? (
              <>
                <p>
                  Required App Builder connection endpoint: <code>{data.mcpUrl}</code>. Before
                  sending, confirm your plugin connection targets this endpoint. The official
                  release plugin may target Production; local and Preview handoffs need a matching
                  configured App Builder plugin connection.
                </p>
                <p>
                  Install the official App Builder plugin in Codex, enable it, and connect to
                  Autograph. If prompted to reload, open a fresh task and resend the prepared
                  prompt.
                </p>
                <pre style={{ whiteSpace: "pre-wrap" }}>
                  <code>{codexInstallCommand}</code>
                </pre>
              </>
            ) : installUrl ? (
              <>
                <a href={installUrl}>Add Autograph to Cursor</a>
                <p>
                  Approve the connection in Cursor, then return here and open your prepared prompt.
                </p>
              </>
            ) : (
              <p>
                Cursor connection setup is not available in this environment yet. If Autograph is
                already connected, open the prompt above; otherwise use Codex or return later.
              </p>
            )}
          </details>
        </>
      ) : null}
      {notice ? <p role="alert">{notice}</p> : null}
      {renewalNotice ? <p role="alert">{renewalNotice}</p> : null}
    </section>
  );
}
