import { integrationCapabilityPlan as legacy } from "./app-integration-capability-test-fixture";

export const integrationCapabilityV2PlanInput = () => ({
  ...legacy,
  effects: [
    "prepare-control-database",
    "install-control-schema",
    "bind-service-memberships",
    "prepare-provider-destination",
    "register-central-app",
  ],
  kind: "app-integrations-capability-plan-v2",
  machineIngress: [
    {
      kind: "quickbooks-ingress",
      method: "POST",
      path: `/${legacy.selection.appId}/api/integrations/quickbooks`,
    },
  ],
  providerDestination: {
    name: "isolated-reads",
    origin: legacy.publicOrigin,
    path: `/${legacy.selection.appId}/api/integrations/quickbooks`,
  },
  resourceWorker: { id: "neon-resource-bootstrap-v1", sha256: "a".repeat(64) },
  version: 2,
});
