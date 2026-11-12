import { defineState } from "eve/context";
import type { OwnedCompletedAppPublication } from "./github-publication-runtime";

type OwnedDraftPublicationSeal = OwnedCompletedAppPublication & {
  appId: string;
  sessionId: string;
};

// Keep the seal independently of the mutable planning and review phases. A seal
// supplies only a lookup key. The protected journal and GitHub still prove the result.
const ownedDraftPublicationSeals = defineState<OwnedDraftPublicationSeal[]>(
  "autograph-app-builder.github-draft-publication-lineage.v1",
  () => [],
);

export const retainOwnedDraftPublicationSeal = (seal: OwnedDraftPublicationSeal): void => {
  ownedDraftPublicationSeals.update((current) =>
    current.some(
      ({ sessionId, appId, proposal }) =>
        sessionId === seal.sessionId &&
        appId === seal.appId &&
        proposal.digest === seal.proposal.digest,
    )
      ? current
      : [...current, seal],
  );
};

export const ownedDraftPublicationHistory = (scope: {
  sessionId: string;
  appId: string;
  repositoryId: string;
  owner: string;
  name: string;
}) =>
  ownedDraftPublicationSeals
    .get()
    .toReversed()
    .filter(({ sessionId, appId, proposal }) =>
      [
        sessionId === scope.sessionId,
        appId === scope.appId,
        proposal.repositoryId === scope.repositoryId,
        proposal.owner === scope.owner,
        proposal.name === scope.name,
      ].every(Boolean),
    );
