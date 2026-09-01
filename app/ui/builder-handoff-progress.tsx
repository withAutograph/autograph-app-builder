import {
  AlertCircle,
  Check,
  ChevronRight,
  Clock,
  ExternalLink,
} from "@geist-ui/icons";

import styles from "./app-builder.module.css";

export function BuilderHandoffProgress({
  stages,
  step,
  handoffError,
  onRetry,
}: {
  stages: string[];
  step: number;
  handoffError: boolean;
  onRetry: () => void;
}) {
  return (
    <main className={styles.flowPage} id="main-content">
      <section className={styles.deploymentCard}>
        <div className={styles.deploymentBody}>
          <h1>Handoff</h1>
          <p className={styles.creating}>
            {handoffError ? (
              <AlertCircle size={18} aria-hidden="true" />
            ) : (
              <span className={styles.spinner} aria-hidden="true" />
            )}
            {handoffError
              ? "We couldn’t finish preparing this handoff."
              : "Preparing your app and handoff…"}
          </p>
          {handoffError ? (
            <button type="button" onClick={onRetry}>
              Try again
            </button>
          ) : null}
          <div className={styles.stageList}>
            {stages.map((stage, index) => (
              <div
                key={stage}
                data-active={index === step}
                data-complete={index < step}
              >
                {index < step || step >= stages.length ? (
                  <Check size={17} aria-hidden="true" />
                ) : index === step ? (
                  <span className={styles.spinner} aria-hidden="true" />
                ) : (
                  <Clock size={18} aria-hidden="true" />
                )}
                <span>{stage}</span>
                {index > 0 ? (
                  <ChevronRight size={17} aria-hidden="true" />
                ) : null}
              </div>
            ))}
          </div>
        </div>
        <footer>
          <ExternalLink size={18} aria-hidden="true" /> Tip: Review and send the
          brief in your selected client.
        </footer>
      </section>
      <p className={styles.liveStatus} role="status" aria-live="polite">
        {step >= stages.length
          ? "Your secure handoff is ready. Opening your selected client."
          : handoffError
            ? "Try again. Your app brief and completed setup are safe."
            : stages[Math.min(step, stages.length - 1)]}
      </p>
    </main>
  );
}
