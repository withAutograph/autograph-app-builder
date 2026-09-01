import { Copy, X } from "@geist-ui/icons";
import { useState } from "react";

import styles from "./app-builder.module.css";

export function BuilderInstallInstructions({
  command,
  onDismiss,
}: {
  command: string;
  onDismiss: () => void;
}) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );

  return (
    <section className={styles.installCard}>
      <div>
        <h2>Install App Builder Plugin</h2>
        <button
          type="button"
          aria-label="Dismiss install instructions"
          onClick={onDismiss}
        >
          <X size={17} aria-hidden="true" />
        </button>
      </div>
      <p>
        Run this once in Codex&apos;s terminal. Then open a fresh task and
        describe the app you want to create.
      </p>
      <div className={styles.command}>
        <code>{command}</code>
        <button
          type="button"
          aria-label="Copy install command"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(command);
              setCopyState("copied");
            } catch {
              setCopyState("failed");
            }
          }}
        >
          <Copy size={17} aria-hidden="true" />
        </button>
      </div>
      <span role="status" aria-live="polite">
        {copyState === "copied" ? "Install command copied." : null}
        {copyState === "failed"
          ? "Copy failed. Select and copy the command manually."
          : null}
      </span>
    </section>
  );
}
