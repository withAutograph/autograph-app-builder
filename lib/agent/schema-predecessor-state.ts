import { defineState } from "eve/context";
import { compiledOperatorReleaseSelectionSchema } from "../provisioning/hosted-operator-artifact-selection";
import type { CompiledOperatorReleaseSelection } from "../provisioning/hosted-operator-artifact-selection";

/** Immutable release references survive checkout rewrites and ordinary Builder recovery. */
export const canonicalSchemaPredecessorState = defineState<CompiledOperatorReleaseSelection[]>(
  "autograph-app-builder.canonical-schema-predecessors.v1",
  () => [],
);

export interface CompiledSchemaPredecessorInput {
  compiled?: CompiledOperatorReleaseSelection;
  predecessors: CompiledOperatorReleaseSelection[];
}

/** Only the latest successful compilation input for each app; never artifact bytes or credentials. */
export const compiledSchemaPredecessorState = defineState<
  Record<string, CompiledSchemaPredecessorInput>
>("autograph-app-builder.compiled-schema-predecessors.v2", () => ({}));

export const rememberCompiledSchemaPredecessors = (
  appId: string,
  predecessors: readonly CompiledOperatorReleaseSelection[],
  compiledSelection?: CompiledOperatorReleaseSelection,
) => {
  const selections = predecessors.map((input) =>
    compiledOperatorReleaseSelectionSchema.parse(input),
  );
  if (selections.some((selection) => selection.appId !== appId)) {
    throw new Error("Compiled schema predecessors must belong to the selected app.");
  }
  const compiled =
    compiledSelection === undefined
      ? undefined
      : compiledOperatorReleaseSelectionSchema.parse(compiledSelection);
  if (compiled !== undefined && compiled.appId !== appId) {
    throw new Error("Compiled schema target must belong to the selected app.");
  }
  const retained: CompiledSchemaPredecessorInput = { predecessors: selections };
  if (compiled !== undefined) {
    retained.compiled = compiled;
  }
  compiledSchemaPredecessorState.update((current) => ({ ...current, [appId]: retained }));
};

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
