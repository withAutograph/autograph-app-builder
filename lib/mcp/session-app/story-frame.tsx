import type { ReactNode } from "react";

export function McpStoryFrame({ children }: { children: ReactNode }) {
  return (
    <main className="mcpApp shell story-shell">
      <div className="request-list">{children}</div>
    </main>
  );
}
