import { ArrowLeft } from "@geist-ui/icons";
import Link from "next/link";
import type { ReactNode } from "react";

import styles from "./provider-connection.module.css";

type ProviderConnectionProps = {
  action: string;
  buttonLabel: string;
  children: ReactNode;
  description: string;
  icon: ReactNode;
  returnTo: string;
  resumeKey?: string;
  title: string;
};

export function ProviderConnection({
  action,
  buttonLabel,
  children,
  description,
  icon,
  returnTo,
  resumeKey,
  title,
}: ProviderConnectionProps) {
  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <Link className={styles.back} href={returnTo}>
          <ArrowLeft size={17} aria-hidden="true" /> Back
        </Link>
        <span>New App</span>
      </header>
      <section className={styles.content}>
        <span className={styles.providerIcon} aria-hidden="true">
          {icon}
        </span>
        <h1>{title}</h1>
        <p className={styles.description}>{description}</p>
        {children}
        <form className={styles.form} method="post" action={action}>
          <input name="returnTo" type="hidden" value={returnTo} />
          {resumeKey ? (
            <input name="resumeKey" type="hidden" value={resumeKey} />
          ) : null}
          <button className={styles.button} type="submit">
            {buttonLabel}
          </button>
        </form>
      </section>
    </main>
  );
}

export function ProviderConnectionNotice({
  children,
  status,
}: {
  children: ReactNode;
  status: "error" | "success";
}) {
  return (
    <p className={styles.notice} role={status === "error" ? "alert" : "status"}>
      {children}
    </p>
  );
}
