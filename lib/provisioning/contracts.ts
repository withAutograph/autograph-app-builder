import { createHash } from "node:crypto";

import { deriveBuilderAppId } from "./names";
import {
  builderProvisionRequestSchema,
  builderProvisionResponseSchema,
  type BuilderProvisionRequest,
  type BuilderProvisionResponse,
} from "./contracts-schema";

export * from "./contracts-schema";

export function builderProvisionRequestDigest(input: BuilderProvisionRequest): string {
  const request = builderProvisionRequestSchema.parse(input);
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: request.version,
        requestId: request.requestId,
        appName: request.appName,
        repository: request.repository,
        providers: request.providers,
      }),
    )
    .digest("hex");
}

export function initialBuilderProvisionResponse(
  input: BuilderProvisionRequest,
  now = new Date(),
): BuilderProvisionResponse {
  const request = builderProvisionRequestSchema.parse(input);
  return builderProvisionResponseSchema.parse({
    version: 1,
    requestId: request.requestId,
    requestDigest: builderProvisionRequestDigest(request),
    appId: deriveBuilderAppId(request.appName),
    status: "pending",
    github: request.providers.githubInstallationId
      ? { status: "failed", code: "provider_unavailable", retryable: true }
      : { status: "skipped", code: "not_selected", retryable: false },
    vercel: request.providers.vercelInstallationId
      ? { status: "failed", code: "provider_unavailable", retryable: true }
      : { status: "skipped", code: "not_selected", retryable: false },
    updatedAt: now.toISOString(),
  });
}
