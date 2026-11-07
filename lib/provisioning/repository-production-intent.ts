import { isDeepStrictEqual } from "node:util";
import type { RepositoryProductionIntent } from "./repository-production-contract";

/** Source commits describe the revision; they do not change its approved setup effects. */
export const sameRepositoryProductionSetupEffects = (
  left: RepositoryProductionIntent,
  right: RepositoryProductionIntent,
) => isDeepStrictEqual({ ...left, sourceSha: undefined }, { ...right, sourceSha: undefined });
