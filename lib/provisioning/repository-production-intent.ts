import { isDeepStrictEqual } from "node:util";
import type { RepositoryProductionIntent } from "./repository-production-contract";
import { repositoryProductionSignupSelection } from "./repository-production-signup-policy";

const effects = (intent: RepositoryProductionIntent) => ({
  ...intent,
  access: repositoryProductionSignupSelection(intent),
  // oxlint-disable-next-line sonarjs/no-undefined-assignment -- The canonical selection above retains the path only when signup authorizes it.
  entryPath: undefined,
  // oxlint-disable-next-line sonarjs/no-undefined-assignment -- Source commits are diagnostics rather than setup effects.
  sourceSha: undefined,
  // oxlint-disable-next-line sonarjs/no-undefined-assignment -- The secure creator selection is retained separately from setup effects.
  creatorEmail: undefined,
});

/** Source commits describe the revision; they do not change its approved setup effects. */
export const sameRepositoryProductionSetupEffects = (
  left: RepositoryProductionIntent,
  right: RepositoryProductionIntent,
) => isDeepStrictEqual(effects(left), effects(right));
