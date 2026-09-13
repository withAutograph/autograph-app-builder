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
    github: request.providers.githubInstallationId
      ? { code: "provider_unavailable", retryable: true, status: "failed" }
      : { code: "not_selected", retryable: false, status: "skipped" },
    requestDigest: builderProvisionRequestDigest(request),
    requestId: request.requestId,
    status: "pending",
    updatedAt: now.toISOString(),
    vercel: request.providers.vercelInstallationId
      ? { code: "provider_unavailable", retryable: true, status: "failed" }
      : { code: "not_selected", retryable: false, status: "skipped" },
    version: 1,
  });
}
