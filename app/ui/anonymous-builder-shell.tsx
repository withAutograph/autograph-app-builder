import Link from "next/link";
import type { ReactNode } from "react";

import styles from "./app-builder.module.css";
import { AutographMark } from "./autograph-mark";

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function AnonymousBuilderShell({ children }: { children: ReactNode }) {
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
          <Link href="/auth/sign-in?callbackURL=%2F" prefetch={true}>
            Sign In
          </Link>
          <Link className={styles.darkButton} href="/auth/sign-up?callbackURL=%2F" prefetch={true}>
            Sign Up
          </Link>
        </div>
      </header>
      <section className={styles.promptCard}>
        <div className={styles.cardTitle}>
          <h1>Build an app</h1>
          <AutographMark compact />
        </div>
        <label htmlFor="anonymous-brief">What should this app do?</label>
        {children}
        <p>You’ll create or sign in to your Autograph account before building.</p>
      </section>
    </main>
  );
}
