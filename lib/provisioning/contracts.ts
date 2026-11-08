import { createHash } from "node:crypto";

import { deriveBuilderAppId } from "./names";
import { builderProvisionRequestSchema, builderProvisionResponseSchema } from "./contracts-schema";
import type { BuilderProvisionRequest, BuilderProvisionResponse } from "./contracts-schema";

export * from "./contracts-schema";

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function builderProvisionRequestDigest(input: BuilderProvisionRequest): string {
  const request = builderProvisionRequestSchema.parse(input);
  return createHash("sha256")
    .update(
      JSON.stringify({
        appName: request.appName,
        ...(request.deploymentAccess === undefined
          ? {}
          : { deploymentAccess: request.deploymentAccess }),
        providers: request.providers,
        repository: request.repository,
        requestId: request.requestId,
        version: request.version,
      }),
    )
    .digest("hex");
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function initialBuilderProvisionResponse(
  input: BuilderProvisionRequest,
  now = new Date(),
): BuilderProvisionResponse {
  const request = builderProvisionRequestSchema.parse(input);
  return builderProvisionResponseSchema.parse({
    appId: deriveBuilderAppId(request.appName),
    ...(request.deploymentAccess === undefined
      ? {}
      : { deploymentAccess: request.deploymentAccess }),
    github:
      request.providers.githubInstallationId === undefined
        ? { code: "not_selected", retryable: false, status: "skipped" }
        : { code: "provider_unavailable", retryable: true, status: "failed" },
    requestDigest: builderProvisionRequestDigest(request),
    requestId: request.requestId,
    status: "pending",
    updatedAt: now.toISOString(),
    vercel:
      request.providers.vercelInstallationId === undefined
        ? { code: "not_selected", retryable: false, status: "skipped" }
        : { code: "provider_unavailable", retryable: true, status: "failed" },
    version: 1,
  });
}
