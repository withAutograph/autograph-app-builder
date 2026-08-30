import type { ReactNode } from "react";

import styles from "./app-builder.module.css";

export function CreateAppStoryFrame({ children }: { children: ReactNode }) {
  return (
    <div className={styles.appShell}>
      <main className={styles.authenticatedPage}>
        <form
          className={styles.builderCard}
          onSubmit={(event) => event.preventDefault()}
        >
          {children}
        </form>
      </main>
    </div>
  );
}
