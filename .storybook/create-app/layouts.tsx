import type { ReactNode } from "react";

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function CreateAppFormStoryLayout({ children }: { children: ReactNode }) {
  return (
    <main className="authenticatedPage">
      <form
        className="builderCard"
        onSubmit={(event) => {
          event.preventDefault();
        }}
      >
        {children}
      </form>
    </main>
  );
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function McpBlockStoryLayout({ children }: { children: ReactNode }) {
  return (
    <main className="mcpApp shell story-shell">
      <div className="request-list">{children}</div>
    </main>
  );
}
