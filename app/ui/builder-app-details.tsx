import { RefreshCw } from "@geist-ui/icons";
import Link from "next/link";
import type { UseFormRegisterReturn } from "react-hook-form";

import styles from "./app-builder.module.css";

export function AppDetailsSection({
  appName,
  brief,
  onAppNameChange,
  onBriefChange,
  onCycleBrief,
  appNameRegistration,
  briefRegistration,
}: {
  appName: string;
  brief: string;
  onAppNameChange: (value: string) => void;
  onBriefChange: (value: string) => void;
  onCycleBrief: () => void;
  /**
   * The builder supplies RHF registrations so ordinary parent renders cannot
   * replay a stale watched value over an in-progress native input edit.
   * Stories may omit these and retain their small controlled harnesses.
   */
  appNameRegistration?: UseFormRegisterReturn<"appName">;
  briefRegistration?: UseFormRegisterReturn<"brief">;
}) {
  return (
    <fieldset
      className={`${styles.sectionField} ${styles.appDetailsSection}`}
      data-create-app-section="app-details"
    >
      <legend className={styles.visuallyHidden}>App details</legend>
      <label htmlFor="app-name">
        <span className={styles.fieldLabel}>
          App Name <small aria-hidden="true">Optional</small>
        </span>
        <input
          id="app-name"
          name="app-name"
          aria-label="App Name"
          autoComplete="off"
          spellCheck={false}
          {...(appNameRegistration ?? { value: appName })}
          // Keep RHF's native event path intact. The derived-field callback
          // then updates the synchronous draft checkpoint. Replacing the
          // registration handler left a narrow concurrent-render window where
          // a browser fill could append a manual name to the generated one.
          onChange={(event) => {
            appNameRegistration?.onChange(event);
            onAppNameChange(event.target.value);
          }}
          placeholder="support-app"
        />
      </label>
      <label htmlFor="app-brief">
        <span className={styles.fieldLabel}>
          App Brief <small aria-hidden="true">Required</small>
        </span>
        <div className={styles.briefField}>
          <textarea
            id="app-brief"
            name="app-brief"
            aria-label="App Brief"
            autoComplete="off"
            {...(briefRegistration ?? { value: brief })}
            onChange={(event) => {
              briefRegistration?.onChange(event);
              onBriefChange(event.target.value);
            }}
            placeholder="Describe the app you want to build…"
          />
          <button type="button" aria-label="Try another app brief example" onClick={onCycleBrief}>
            <RefreshCw size={16} aria-hidden="true" />
          </button>
        </div>
      </label>
      <p className={styles.helpText}>
        Define this app’s users, workflow, constraints, and desired outcome.{" "}
        <Link href="/docs">Read the App Builder docs</Link>.
      </p>
    </fieldset>
  );
}
