"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useSyncExternalStore } from "react";

import styles from "./app-builder.module.css";
import { AutographMark } from "./autograph-mark";

const suggestions = [
  "Build a customer feedback portal",
  "Create an internal operations dashboard",
] as const;

function subscribeToClientSnapshot() {
  return () => {
    // The client snapshot has no external subscription.
  };
}

/**
 * The anonymous brief is deliberately browser-local until authentication.
 * The authenticated builder claims it through the existing redirect bridge.
 */
export function AnonymousBuilder({ onContinue }: { onContinue?: (brief: string) => void }) {
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
    <main className={styles.anonymousPage} id="main-content">
      <a className={styles.skipLink} href="#anonymous-brief">
        Skip to content
      </a>
      <header className={styles.publicHeader}>
        <AutographMark />
        <span>New App</span>
        <div>
          <Link href="/docs">Docs</Link>
          <a href="/auth/sign-in?callbackURL=%2F">Sign In</a>
          <a className={styles.darkButton} href="/auth/sign-up?callbackURL=%2F">
            Sign Up
          </a>
        </div>
      </header>
      <section className={styles.promptCard}>
        <div className={styles.cardTitle}>
          <h1>Build an app</h1>
          <AutographMark compact />
        </div>
        <label htmlFor="anonymous-brief">What should this app do?</label>
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
            <button type="button" key={suggestion} onClick={() => setBrief(suggestion)}>
              {suggestion}
            </button>
          ))}
        </div>
        <p>You’ll create or sign in to your Autograph account before building.</p>
      </section>
    </main>
  );
}
