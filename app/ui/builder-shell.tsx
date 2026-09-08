import { ArrowLeft, Check, Info } from "@geist-ui/icons";
import Link from "next/link";

import { UserButton } from "../../components/auth/user/user-button";
import {
  providerConnectionFailureMessage,
  type ProviderConnectionNotice,
} from "../../lib/integrations/provider-connection-status";
import styles from "./app-builder.module.css";

export function Header() {
  return (
    <header className={styles.header}>
      <a className={styles.skipLink} href="#main-content">
        Skip to content
      </a>
      <Link href="/" className={styles.back}>
        <ArrowLeft size={17} aria-hidden="true" /> Back
      </Link>
      <span>New App</span>
      <div className={styles.headerActions}>
        <UserButton align="end" sideOffset={8} size="icon" />
      </div>
    </header>
  );
}

export function ProviderNotices({
  notices,
}: {
  notices: ProviderConnectionNotice[];
}) {
  if (!notices.length) return null;
  return (
    <div className={styles.providerNotices} aria-live="polite">
      {notices.map((notice) => {
        const provider = notice.provider === "vercel" ? "Vercel" : "GitHub";
        return (
          <p
            key={`${notice.provider}-${notice.status}`}
            role={notice.status === "failed" ? "alert" : "status"}
            data-status={notice.status}
          >
            {notice.status === "connected" ? (
              <>
                <Check size={15} aria-hidden="true" />
                {provider} connected successfully.
              </>
            ) : (
              <>
                <Info size={15} aria-hidden="true" />
                {providerConnectionFailureMessage(provider, notice.reason)}
              </>
            )}
          </p>
        );
      })}
    </div>
  );
}
