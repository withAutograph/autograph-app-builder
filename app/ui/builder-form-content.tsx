import { SectionShell } from "@/components/create-app/choice-card";

import {
  BuilderAppDetails,
  BuilderConnections,
  BuilderDeployment,
  BuilderDestination,
  BuilderModel,
  BuilderProviderNotices,
  BuilderStorage,
  BuilderSubmit,
} from "./builder-form-islands";
import styles from "./app-builder.module.css";

/** Server-owned form structure; only the controls subscribe to the live draft. */
export function BuilderFormContent({ connectionsEnabled }: { connectionsEnabled: boolean }) {
  return (
    <>
      <div className={styles.cardTitle}>
        <div>
          <h1>Build an app</h1>
          <p>
            Describe what you want to build, then choose how it should be created and delivered.
          </p>
        </div>
      </div>
      <BuilderProviderNotices />
      <fieldset
        className={`${styles.sectionField} ${styles.appDetailsSection}`}
        data-create-app-section="app-details"
      >
        <legend className={styles.visuallyHidden}>App details</legend>
        <BuilderAppDetails />
      </fieldset>
      <SectionShell
        className={`${styles.sectionField} ${styles.buildSection}`}
        section="build-with"
        title="Build with"
        description="Where do you want to build this app?"
      >
        <BuilderDestination />
      </SectionShell>
      <BuilderModel />
      <SectionShell
        className={`${styles.sectionField} ${styles.storeSection}`}
        section="store-in"
        title="Store in"
        description="Where do you want to store this app?"
      >
        <BuilderStorage />
      </SectionShell>
      <SectionShell
        className={`${styles.sectionField} ${styles.deploySection}`}
        section="deploy-to"
        title="Deploy to"
        description="Where do you want to deploy this app?"
      >
        <BuilderDeployment />
      </SectionShell>
      {connectionsEnabled ? (
        <SectionShell
          className={`${styles.sectionField} ${styles.connectionsSection}`}
          section="connections"
          title="Connections"
          description="Give this app access to tools and data from other services."
        >
          <BuilderConnections />
        </SectionShell>
      ) : null}
      <BuilderSubmit />
    </>
  );
}
