import { RefreshCw } from "@geist-ui/icons";

import styles from "./app-builder.module.css";

export function AppDetailsSection({
  appName,
  brief,
  onAppNameChange,
  onBriefChange,
  onCycleBrief,
}: {
  appName: string;
  brief: string;
  onAppNameChange: (value: string) => void;
  onBriefChange: (value: string) => void;
  onCycleBrief: () => void;
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
          value={appName}
          onChange={(event) => onAppNameChange(event.target.value)}
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
            value={brief}
            onChange={(event) => onBriefChange(event.target.value)}
            placeholder="Describe the app you want to build…"
          />
          <button
            type="button"
            aria-label="Try another app brief example"
            onClick={onCycleBrief}
          >
            <RefreshCw size={16} aria-hidden="true" />
          </button>
        </div>
      </label>
      <p className={styles.helpText}>
        Define this app’s users, workflow, constraints, and desired outcome.{" "}
        <a
          href="https://github.com/withAutograph/autograph-app-builder"
          target="_blank"
          rel="noreferrer"
        >
          Read the App Builder docs ↗
        </a>
        .
      </p>
    </fieldset>
  );
}
