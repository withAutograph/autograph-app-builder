import {
  Check,
  ChevronRight,
  DollarSign,
  GitBranch,
  Globe,
} from "@geist-ui/icons";

import styles from "./app-builder.module.css";

export function BuilderNextSteps({ onReset }: { onReset: () => void }) {
  return (
    <>
      <h2 className={styles.nextTitle}>Next Steps</h2>
      <div className={styles.nextSteps}>
        <div>
          <span>
            <GitBranch size={17} aria-hidden="true" />
          </span>
          <p>
            <strong>Start a New Task</strong>Paste your prepared brief into your
            connected client.
          </p>
        </div>
        <div>
          <span>
            <DollarSign size={17} aria-hidden="true" />
          </span>
          <p>
            <strong>Review the Plan</strong>Approve only the changes you want to
            make.
          </p>
          <ChevronRight size={18} aria-hidden="true" />
        </div>
        <div>
          <span>
            <Globe size={17} aria-hidden="true" />
          </span>
          <p>
            <strong>Connect a Repository</strong>Choose the exact repository for
            the app.
          </p>
          <ChevronRight size={18} aria-hidden="true" />
        </div>
        <div>
          <span>
            <Check size={17} aria-hidden="true" />
          </span>
          <p>
            <strong>Validate the Build</strong>Confirm the acceptance criteria
            in your connected client.
          </p>
          <ChevronRight size={18} aria-hidden="true" />
        </div>
      </div>
      <button className={styles.createButton} type="button" onClick={onReset}>
        Create Another App
      </button>
    </>
  );
}
