"use client";

import type { ReactNode } from "react";
import { ConnectionDrawer } from "./builder-connections";
import { BuilderControllerContext } from "./builder-form-context";
import { useBuilderController } from "./use-builder-controller";
import styles from "./app-builder.module.css";

/** Browser behavior wraps server-composed form content without importing it. */
export function Builder({
  children,
  draftStatus,
  ...props
}: Parameters<typeof useBuilderController>[0] & { children: ReactNode; draftStatus: ReactNode }) {
  const controller = useBuilderController(props);
  const {
    submissionPending,
    preparingSubmission,
    submit,
    interactive,
    connectionFlow,
    setConnectionFlow,
    completeConnection,
  } = controller;
  return (
    <BuilderControllerContext value={controller}>
      <main
        className={styles.authenticatedPage}
        id="main-content"
        inert={submissionPending || preparingSubmission}
        aria-busy={submissionPending || preparingSubmission}
      >
        <form className={styles.builderCard} onSubmit={submit}>
          {draftStatus}
          <fieldset
            className={styles.builderControls}
            disabled={!interactive}
            aria-busy={!interactive}
          >
            {children}
          </fieldset>
        </form>
        {connectionFlow ? (
          <ConnectionDrawer
            flow={connectionFlow}
            onClose={() => setConnectionFlow(null)}
            onStageChange={(stage) =>
              setConnectionFlow((current) => (current ? { ...current, stage } : current))
            }
            onConnected={completeConnection}
          />
        ) : null}
      </main>
    </BuilderControllerContext>
  );
}
