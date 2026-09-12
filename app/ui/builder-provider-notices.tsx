import { Check, Info } from "@geist-ui/icons";
import { providerConnectionFailureMessage } from "@/lib/integrations/provider-connection-status";
import type { ProviderConnectionNotice } from "@/lib/integrations/provider-connection-status";
import styles from "./app-builder.module.css";

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function ProviderNotices({ notices }: { notices: ProviderConnectionNotice[] }) {
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
