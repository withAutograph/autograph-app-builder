import type { createHostedOperatorControlPlane } from "./hosted-operator-deployment";
import { HostedOperatorError } from "./hosted-operator-contract";
import type { HostedOperatorContext } from "./hosted-operator-service";

type ControlPlane = Pick<
  Awaited<ReturnType<typeof createHostedOperatorControlPlane>>,
  "readCurrentPlanningOwner" | "readGeneratedSelection"
>;

/** Private canonical accepted state, independently re-read under current owner authority. */
export const readOwnedOperatorPlanningSelection = async (input: {
  context: HostedOperatorContext;
  controlPlane: ControlPlane;
}) => {
  const context = structuredClone(input.context);
  const owned = await input.controlPlane.readCurrentPlanningOwner(context);
  const decision = owned.session.privateBuildDecision;
  const currentSpec = decision?.currentSpec;
  if (currentSpec === undefined || decision === undefined) {
    throw new HostedOperatorError("operator_unavailable");
  }
  const matchesOwner = [
    decision.adapterSessionId === owned.session.adapterSessionId,
    currentSpec.sessionId === owned.session.adapterSessionId,
    currentSpec.workspaceId === context.authority.workspaceId,
    currentSpec.appId === context.target.appId,
  ].every(Boolean);
  if (!matchesOwner) {
    throw new HostedOperatorError("operator_unavailable");
  }
  // Artifacts use the public canonical owner session; currentSpec identifies its adapter.
  const selection = await input.controlPlane.readGeneratedSelection(
    context,
    currentSpec.appSpecDigest,
  );
  // Fresh owner authorization is required; ordinary accepted-spec edits are new
  // planning input, not a reason to reject this coherent immutable snapshot.
  await input.controlPlane.readCurrentPlanningOwner(context);
  return { approvedScope: decision.scope, currentSpec, selection };
};
