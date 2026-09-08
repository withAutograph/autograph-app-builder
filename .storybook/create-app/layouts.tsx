import type { ReactNode } from "react";

import styles from "../../app/ui/app-builder.module.css";

export function CreateAppFormStoryLayout({
  children,
}: {
  children: ReactNode;
}) {
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

export function McpBlockStoryLayout({ children }: { children: ReactNode }) {
  return (
    <main className="mcpApp shell story-shell">
      <div className="request-list">{children}</div>
    </main>
  );
}
