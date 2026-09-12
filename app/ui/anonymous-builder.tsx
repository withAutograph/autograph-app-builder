import { AnonymousBrief } from "./anonymous-brief";
import { AnonymousBuilderShell } from "./anonymous-builder-shell";

/** Server composition keeps static content outside the interactive brief island. */
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function AnonymousBuilder() {
  return (
    <AnonymousBuilderShell>
      <AnonymousBrief />
    </AnonymousBuilderShell>
  );
}
