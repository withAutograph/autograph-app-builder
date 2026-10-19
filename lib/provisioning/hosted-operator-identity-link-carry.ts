import { matchesHostedOperatorIdentityLinkScope } from "./hosted-operator-contract";
import type { HostedOperatorRecord } from "./hosted-operator-contract";

/** A consumed proof remains authority only within its original compatible identity scope. */
export const retainedConsumedIdentityLink = (
  prior: HostedOperatorRecord,
  successor: HostedOperatorRecord,
): HostedOperatorRecord["identityLink"] => {
  const link = prior.identityLink;
  if (successor.plan.action !== "prepare" || link?.consumedAt === undefined) {
    return undefined;
  }
  return matchesHostedOperatorIdentityLinkScope({ ...successor, identityLink: link })
    ? link
    : undefined;
};
