"use client";

import { useRouter } from "next/navigation";
import { useState, useSyncExternalStore } from "react";

import styles from "./app-builder.module.css";

const suggestions = [
  "Build a customer feedback portal",
  "Create an internal operations dashboard",
] as const;

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function subscribeToClientSnapshot() {
  return () => {
    // The client snapshot has no external subscription.
  };
}

/**
 * The anonymous brief is deliberately browser-local until authentication.
 * The authenticated builder claims it through the existing redirect bridge.
 */
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function AnonymousBrief({ onContinue }: { onContinue?: (brief: string) => void }) {
  const router = useRouter();
  const [brief, setBrief] = useState("");
  const isInteractive = useSyncExternalStore(
    subscribeToClientSnapshot,
    () => true,
    () => false,
  );
  const continueToSignIn = (value: string) => {
    if (onContinue) {
      onContinue(value);
      return;
    }
    sessionStorage.setItem("autograph-app-brief", value);
    router.push("/auth/sign-in?callbackURL=%2F");
  };

  return (
    <>
      <div className={styles.promptField}>
        <textarea
          id="anonymous-brief"
          name="app-brief"
          autoComplete="off"
          disabled={!isInteractive}
          value={brief}
          onChange={(event) => setBrief(event.target.value)}
          placeholder="Help me create a customer portal, build an internal dashboard, or launch a new workflow…"
        />
        <button
          type="button"
          disabled={!isInteractive || !brief.trim()}
          onClick={() => continueToSignIn(brief)}
        >
          Continue
        </button>
      </div>
      <div className={styles.suggestions}>
        <span>Suggestions</span>
        {suggestions.map((suggestion) => (
          <button
            type="button"
            key={suggestion}
            disabled={!isInteractive}
            onClick={() => setBrief(suggestion)}
          >
            {suggestion}
          </button>
        ))}
      </div>
    </>
  );
}
