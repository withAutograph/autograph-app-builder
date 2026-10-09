import { defineState } from "eve/context";
import { compiledOperatorReleaseSelectionSchema } from "../provisioning/hosted-operator-artifact-selection";
import type { CompiledOperatorReleaseSelection } from "../provisioning/hosted-operator-artifact-selection";

/** Immutable release references survive checkout rewrites and ordinary Builder recovery. */
export const canonicalSchemaPredecessorState = defineState<CompiledOperatorReleaseSelection[]>(
  "autograph-app-builder.canonical-schema-predecessors.v1",
  () => [],
);

export const rememberCanonicalSchemaRelease = (input: CompiledOperatorReleaseSelection) => {
  const selection = compiledOperatorReleaseSelectionSchema.parse(input);
  canonicalSchemaPredecessorState.update((current) => {
    const retained = current.some(
      (prior) =>
        prior.appId === selection.appId &&
        prior.releaseId === selection.releaseId &&
        prior.schemaSha256 === selection.schemaSha256,
    );
    return retained ? current : [...current, selection];
  });
};
