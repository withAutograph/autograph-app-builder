import { centralHostApprovalInputSchema } from "../provisioning/central-integration-host-transport";

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Ordinary Native approval input is untrusted and parsed immediately against the complete closed plan.
export const centralHostApprovalDescription = (input: unknown): string | undefined => {
  const parsed = centralHostApprovalInputSchema.safeParse(input);
  if (!parsed.success) {
    return undefined;
  }
  const { plan, operationRef, planDigest } = parsed.data;
  const identity = `App: ${plan.selection.initiatingAppId}\nIntent: ${operationRef}\nPlan: ${planDigest}`;
  if (plan.kind === "central-integration-host-caller-v1") {
    return [
      "Allow this app's Production workload to call the existing isolated central Integrations Preview host through Vercel Trusted Sources.",
      identity,
      `Exact caller project: ${plan.caller.projectId}\nCentral project: ${plan.central.projectId}\nAccepted deployment: ${plan.central.providerDeploymentId}\nCentral origin: ${plan.central.immutableOrigin}`,
      "Preserve sibling grants. A full-state change detected before dispatch stops for review. An external dashboard edit racing the provider update can still conflict because the provider exposes no conditional update. This does not activate QuickBooks or change the app's public authentication.",
    ].join("\n\n");
  }
  const effects = plan.effects.map((effect) => `- ${effect}`).join("\n");
  return [
    "Set up the isolated central Integrations host and publish its reviewed source through native Git delivery.",
    identity,
    `Destination: ${plan.target.projectId} / Preview / ${plan.source.operationBranch}\nServices: ${plan.source.serviceIds.join(", ")}\nReviewed source: ${plan.source.reviewedSourceSha}`,
    `Development control resource: ${plan.control.resource.resourceId}\nDatabase: ${plan.control.resource.database}\nCentral runtime role: ${plan.control.centralRuntimeRole}\nResource profile: ${plan.resourceProfileId}`,
    `Effects, in order:\n${effects}\nBranch-scoped encrypted settings: ${plan.environment.map((entry) => entry.key).join(", ")}\nDeployment-event receiver: ${plan.receiver.publicOrigin}${plan.receiver.path}\nInspector workload: ${plan.inspector.projectId} / ${plan.inspector.environment} → central Preview`,
    "Preserve other branches, runtime settings and Trusted Sources grants. External dashboard changes racing the full-state provider update may conflict; uncertain outcomes remain pending. Provider activation and customer Production changes require separate scope. Deployment identity comes from a signed provider event and independent readback.",
  ].join("\n\n");
};
