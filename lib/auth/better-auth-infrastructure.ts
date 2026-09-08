import { dash } from "@better-auth/infra";

const ENABLED_VALUE = "starter-dashboard-v1";

export interface BetterAuthInfrastructureEnvironment {
  BETTER_AUTH_INFRASTRUCTURE?: string;
  BETTER_AUTH_API_KEY?: string;
}

export interface BetterAuthInfrastructureOptions {
  environment: BetterAuthInfrastructureEnvironment;
  organizationAuthorityReady: boolean;
}

export interface BetterAuthInfrastructureSummary {
  enabled: boolean;
  plan: "starter" | null;
  organizationAuthorityReady: boolean;
}

function readApiKey(value: string | undefined): string {
  const apiKey = value?.trim();
  if (!apiKey) {
    throw new Error(
      "BETTER_AUTH_API_KEY is required when Better Auth Infrastructure is enabled",
    );
  }
  return apiKey;
}

export function resolveBetterAuthInfrastructure(
  options: BetterAuthInfrastructureOptions,
) {
  const configuredValue =
    options.environment.BETTER_AUTH_INFRASTRUCTURE?.trim();

  if (!configuredValue) {
    return {
      plugins: [],
      summary: {
        enabled: false,
        plan: null,
        organizationAuthorityReady: options.organizationAuthorityReady,
      } satisfies BetterAuthInfrastructureSummary,
    };
  }

  if (configuredValue !== ENABLED_VALUE) {
    throw new Error(
      `BETTER_AUTH_INFRASTRUCTURE must be exactly ${ENABLED_VALUE}`,
    );
  }

  if (!options.organizationAuthorityReady) {
    throw new Error(
      "Better Auth Infrastructure cannot start before organization authority migration is verified",
    );
  }

  const apiKey = readApiKey(options.environment.BETTER_AUTH_API_KEY);

  return {
    plugins: [dash({ apiKey })],
    summary: {
      enabled: true,
      plan: "starter",
      organizationAuthorityReady: true,
    } satisfies BetterAuthInfrastructureSummary,
  };
}
