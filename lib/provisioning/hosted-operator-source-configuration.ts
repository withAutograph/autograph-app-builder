import { createHostedOperatorControlPlane } from "./hosted-operator-deployment";
import type { OperatorWorkloadPolicy } from "./hosted-operator-workload";
import {
  hostedOperatorSourceConfigurationSchema,
  validateHostedOperatorSourceConfiguration,
} from "./hosted-operator-source-configuration-schema";

export {
  hostedOperatorSandboxConfigurationSchema,
  hostedOperatorSourceConfigurationSchema,
  validateHostedOperatorSourceConfiguration,
} from "./hosted-operator-source-configuration-schema";
export type { HostedOperatorSourceConfiguration } from "./hosted-operator-source-configuration-schema";

/** Deployment-owned exact configuration. Missing setup is unavailable; no default project, role, source or grant is invented. */
export const readHostedOperatorSourceConfiguration = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
) => {
  const text = environment.PROTECTED_HOSTED_OPERATOR_CONFIGURATION;
  if (text === undefined || text === "") {
    throw new Error("Protected operator deployment configuration is unavailable.");
  }
  return validateHostedOperatorSourceConfiguration(
    hostedOperatorSourceConfigurationSchema.parse(JSON.parse(text)),
  );
};

/** Real reusable control plane for native operator composition and the owner-authenticated callback. */
export const openHostedOperatorCompositionResources = async (
  environment: Readonly<Record<string, string | undefined>> = process.env,
) => {
  const configuration = readHostedOperatorSourceConfiguration(environment);
  const controlPlane = await createHostedOperatorControlPlane({
    environment,
    sourceConfiguration: configuration,
    workloadPolicy: configuration.workloadPolicy satisfies OperatorWorkloadPolicy,
  });
  return { configuration, controlPlane };
};
