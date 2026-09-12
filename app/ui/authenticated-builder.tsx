import { BuilderContinuation } from "./builder-continuation";
import type { AuthenticatedBuilderProps } from "./builder-continuation";
import { BuilderFormContent } from "./builder-form-content";
import { BuilderDraftStatus } from "./builder-form-islands";

export type { AuthenticatedBuilderProps } from "./builder-continuation";

/** Compose the server-owned form inside its browser-only action/draft boundary. */
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function AuthenticatedBuilder(props: AuthenticatedBuilderProps) {
  return (
    <BuilderContinuation {...props} draftStatus={<BuilderDraftStatus />}>
      <BuilderFormContent connectionsEnabled={props.connectionsEnabled ?? false} />
    </BuilderContinuation>
  );
}
