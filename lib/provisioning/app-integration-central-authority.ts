import type { AppIntegrationCapabilityPlan } from "./app-integration-capability-contract";

/** Canonical central-setup receipt, independently revalidated for this app caller; never supplied by a model. */
export interface CentralIntegrationHostReadyReceipt {
  version: 1;
  kind: "central-integration-host-ready-v1";
  authority: AppIntegrationCapabilityPlan["authority"];
  setup: { operationRef: string; planDigest: string };
  callerSetup: { operationRef: string; planDigest: string };
  profile: { id: string; digest: string };
  resourceProfileId: string;
  control: {
    resource: Omit<AppIntegrationCapabilityPlan["control"]["database"], "runtimeRole">;
    centralRuntimeRole: string;
    neon: AppIntegrationCapabilityPlan["runtime"]["neon"];
    schemaSha256: string;
  };
  activation: { keyId: string; publicKeyPem: string; publicKeySha256: string };
  provider: Omit<
    AppIntegrationCapabilityPlan["provider"],
    "recipeId" | "recipeVersion" | "readObjectsSha256"
  >;
  deployment: {
    projectId: string;
    teamId: string;
    installationId: string;
    environment: "preview";
    serviceId: "integrations";
    providerDeploymentId: string;
    immutableOrigin: string;
    configurationRef: string;
    configurationSha256: string;
  };
  caller: {
    projectId: string;
    ownerId: string;
    environment: "production";
    trustedSourcesGrantSha256: string;
  };
}
export type ReadCentralIntegrationHostReady = (input: {
  authority: AppIntegrationCapabilityPlan["authority"];
  appId: string;
  appProjectId: string;
  teamId: string;
  assertCurrentOwner: () => Promise<void>;
  signal: AbortSignal;
}) => Promise<CentralIntegrationHostReadyReceipt | undefined>;
