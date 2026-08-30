import type { ReactNode } from "react";

import styles from "./app-builder.module.css";

export function CreateAppStoryFrame({ children }: { children: ReactNode }) {
  return (
    <main className={styles.authenticatedPage}>
      <form
        className={styles.builderCard}
        onSubmit={(event) => event.preventDefault()}
      >
        {children}
      </form>
    </main>
  );
}
