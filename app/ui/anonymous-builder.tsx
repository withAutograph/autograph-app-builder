import { AnonymousBrief } from "./anonymous-brief";
import { AnonymousBuilderShell } from "./anonymous-builder-shell";

/** Server composition keeps static content outside the interactive brief island. */
export function AnonymousBuilder() {
  return (
    <AnonymousBuilderShell>
      <AnonymousBrief />
    </AnonymousBuilderShell>
  );
}
