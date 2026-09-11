import { ArrowLeft, ArrowRight, Check, LockKeyhole } from "lucide-react";
import type { ReactNode } from "react";
import { FaGithub } from "react-icons/fa";

import styles from "./emulation-approval.module.css";

export type EmulatedProvider = "github" | "vercel";

export function VercelMark({ size = 20 }: { size?: number }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="currentColor"
    >
      <path d="M12 3 23 21H1L12 3Z" />
    </svg>
  );
}

function ProviderMark({ provider }: { provider: EmulatedProvider }) {
  return provider === "github" ? (
    <FaGithub aria-hidden="true" size={20} />
  ) : (
    <VercelMark />
  );
}

export function EmulationApproval({
  provider,
  environment,
  title,
  description,
  account,
  handle,
  details,
  scope,
  actionLabel,
  action,
  backHref = "/",
}: {
  provider: EmulatedProvider;
  environment: "Local development" | "Preview deployment";
  title: string;
  description: string;
  account: string;
  handle: string;
  details: ReadonlyArray<{ label: string; value: string }>;
  scope: string;
  actionLabel: string;
  action: ReactNode;
  backHref?: string;
}) {
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <a className={styles.back} href={backHref}>
          <ArrowLeft aria-hidden="true" size={16} />
          Back
        </a>
        <p className={styles.title}>App Builder</p>
        <span className={styles.environment}>{environment}</span>
      </header>
      <main className={styles.main}>
        <section className={styles.card} aria-labelledby="approval-title">
          <div className={styles.providerPair} aria-hidden="true">
            <span className={styles.mark}>
              <VercelMark />
            </span>
            <ArrowRight className={styles.arrow} size={16} />
            <span className={styles.mark}>
              <ProviderMark provider={provider} />
            </span>
          </div>
          <div className={styles.heading}>
            <h1 id="approval-title">{title}</h1>
            <p>{description}</p>
          </div>
          <div className={styles.identity}>
            <span className={styles.identityMark}>
              <ProviderMark provider={provider} />
            </span>
            <span className={styles.identityText}>
              <strong>{account}</strong>
              <span>{handle}</span>
            </span>
            <Check className={styles.check} aria-hidden="true" size={16} />
          </div>
          {details.length ? (
            <dl className={styles.details}>
              {details.map((detail) => (
                <div className={styles.detail} key={detail.label}>
                  <dt>{detail.label}</dt>
                  <dd>{detail.value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          <div className={styles.scope}>
            <LockKeyhole aria-hidden="true" size={16} />
            <span>{scope}</span>
          </div>
          <div className={styles.form} aria-label={actionLabel}>
            {action}
          </div>
          <p className={styles.footer}>
            {environment} only · Powered by Emulate
          </p>
        </section>
      </main>
    </div>
  );
}

export { styles as emulationApprovalStyles };
