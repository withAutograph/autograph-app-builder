"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import {
  buildAppHandoffPrompt,
  buildAppHandoffUrl,
  buildCursorInstallUrl,
  codexInstallCommand,
} from "../../lib/handoff/client";
import type { HandoffDestination } from "../../lib/handoff/client";

import styles from "./app-builder.module.css";
import handoffStyles from "./handoff.module.css";

export interface HandoffControlData {
  version: 1;
  handoffId: string;
  expiresAt: string;
  status: "prepared" | "continued" | "expired";
  destination: HandoffDestination;
  cursorInstallReady: boolean;
  mcpUrl: string;
}

function readStatus(
  value: HandoffControlData,
  handoffId: string
): HandoffControlData {
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
    cursorInstallReady: value.cursorInstallReady,
    destination: value.destination,
    expiresAt: value.expiresAt,
    handoffId,
    mcpUrl: value.mcpUrl,
    status: value.status,
    version: 1,
  };
}

export function HandoffControls({ initial }: { initial: HandoffControlData }) {
  const router = useRouter();
  const [data, setData] = useState(initial);
  const [destination, setDestination] = useState(initial.destination);
  const [notice, setNotice] = useState("");
  const [renewalNotice, setRenewalNotice] = useState("");
  const [launchNotice, setLaunchNotice] = useState("");
  const [copyNotice, setCopyNotice] = useState("");
  const [access, setAccess] = useState<"ready" | "sign-in" | "unavailable">(
    "ready"
  );
  const [renewing, setRenewing] = useState(false);
  const renewalRequestId = useRef<string | undefined>(undefined);
  const renewalInFlight = useRef(false);
  const handoffPath = `/handoff/${encodeURIComponent(data.handoffId)}`;
  const signInUrl = `/auth/sign-in?callbackURL=${encodeURIComponent(handoffPath)}`;
  const label = destination === "codex" ? "Codex" : "Cursor";
  const prompt = buildAppHandoffPrompt(data.handoffId, destination);
  const disabled = access !== "ready" || data.status === "expired" || renewing;
  const installUrl =
    destination === "cursor" && access === "ready"
      ? buildCursorInstallUrl(data.mcpUrl, data.cursorInstallReady)
      : undefined;

  useEffect(() => {
    if (access !== "ready" || renewing || data.status === "continued") {
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
          }
        );
        if (request.signal.aborted || disposed) {
          return;
        }
        if (
          response.status === 401 ||
          response.status === 403 ||
          response.status === 404
        ) {
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
            "Status is temporarily unavailable. Your prepared app is saved; we’ll retry while this page is open."
          );
        }
      } finally {
        if (
          !disposed &&
          !request.signal.aborted &&
          !complete &&
          document.visibilityState === "visible"
        ) {
          timer = setTimeout(() => void refresh(), 5_000);
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
  }, [access, data.handoffId, data.status, renewing]);

  const renew = async () => {
    if (renewalInFlight.current) {
      return;
    }
    renewalInFlight.current = true;
    setRenewing(true);
    setRenewalNotice("");
    const storageKey = `autograph-handoff-renew:${data.handoffId}`;
    try {
      if (!renewalRequestId.current) {
        let saved: string | null = null;
        try {
          saved = sessionStorage.getItem(storageKey);
        } catch {}
        renewalRequestId.current =
          saved && /^[0-9a-f-]{36}$/iu.test(saved)
            ? saved
            : crypto.randomUUID();
        try {
          sessionStorage.setItem(storageKey, renewalRequestId.current);
        } catch {}
      }
      const response = await fetch(
        `/api/builder/handoffs/${encodeURIComponent(data.handoffId)}/renew`,
        {
          body: JSON.stringify({ creationRequestId: renewalRequestId.current }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        }
      );
      if (
        response.status === 401 ||
        response.status === 403 ||
        response.status === 404
      ) {
        setAccess(response.status === 401 ? "sign-in" : "unavailable");
        return;
      }
      if (!response.ok) {
        throw new Error("handoff-renewal-unavailable");
      }
      const renewed = (await response.json()) as {
        version: number;
        handoffId: string;
        expiresAt: string;
      };
      if (
        renewed.version !== 1 ||
        typeof renewed.expiresAt !== "string" ||
        Number.isNaN(Date.parse(renewed.expiresAt))
      ) {
        throw new Error("handoff-response-invalid");
      }
      buildAppHandoffPrompt(renewed.handoffId, destination);
      if (renewed.handoffId === data.handoffId) {
        const status = await fetch(
          `/api/builder/handoffs/${encodeURIComponent(renewed.handoffId)}`,
          { cache: "no-store" }
        );
        if (!status.ok) {
          throw new Error("handoff-status-unavailable");
        }
        setData(readStatus(await status.json(), renewed.handoffId));
      } else {
        router.replace(`/handoff/${encodeURIComponent(renewed.handoffId)}`);
      }
      router.refresh();
    } catch {
      setRenewalNotice(
        "We couldn’t renew this handoff. Try again; your brief and completed resources are saved."
      );
    } finally {
      renewalInFlight.current = false;
      setRenewing(false);
    }
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
      {access === "ready" ? null : (
        <a href={signInUrl}>Sign in with the same account</a>
      )}
      <fieldset disabled={renewing}>
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
          disabled={renewing}
          onClick={() => void renew()}
        >
          {renewing ? "Renewing…" : "Renew handoff"}
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
              "noopener,noreferrer"
            );
            setLaunchNotice(
              `Launch requested for ${label}. If it did not open, try again or paste the prompt manually. Review and send it in ${label}.`
            );
          } catch {
            setLaunchNotice(
              `The browser blocked ${label}. Open it manually and paste the prompt below.`
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
                setCopyNotice(
                  "Copy failed. Select and copy the prompt below manually."
                );
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
              Connect Autograph using the same account and browser profile as
              this form. A new client may ask you to allow Autograph once. Your
              saved GitHub and Vercel connections are reused.
            </p>
            {destination === "codex" ? (
              <>
                <p>
                  Required App Builder connection endpoint:{" "}
                  <code>{data.mcpUrl}</code>. Before sending, confirm your
                  plugin connection targets this endpoint. The official release
                  plugin may target Production; local and Preview handoffs need
                  a matching configured App Builder plugin connection.
                </p>
                <p>
                  Install the official App Builder plugin in Codex, enable it,
                  and connect to Autograph. If prompted to reload, open a fresh
                  task and resend the prepared prompt.
                </p>
                <pre style={{ whiteSpace: "pre-wrap" }}>
                  <code>{codexInstallCommand}</code>
                </pre>
              </>
            ) : installUrl ? (
              <>
                <a href={installUrl}>Add Autograph to Cursor</a>
                <p>
                  Approve the connection in Cursor, then return here and open
                  your prepared prompt.
                </p>
              </>
            ) : (
              <p>
                Cursor connection setup is not available in this environment
                yet. If Autograph is already connected, open the prompt above;
                otherwise use Codex or return later.
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
