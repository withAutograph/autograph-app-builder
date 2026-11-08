import { isDeepStrictEqual } from "node:util";
import type { RepositoryProductionIntent } from "./repository-production-contract";

/** Source commits describe the revision; they do not change its approved setup effects. */
export const sameRepositoryProductionSetupEffects = (
  left: RepositoryProductionIntent,
  right: RepositoryProductionIntent,
) =>
  isDeepStrictEqual(
    // oxlint-disable-next-line sonarjs/no-undefined-assignment -- Preserve the existing explicit undefined value.
    { ...left, sourceSha: undefined, creatorEmail: undefined },
    // oxlint-disable-next-line sonarjs/no-undefined-assignment -- Preserve the existing explicit undefined value.
    { ...right, sourceSha: undefined, creatorEmail: undefined },
  );
