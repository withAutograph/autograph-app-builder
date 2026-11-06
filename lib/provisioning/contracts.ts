import { createHash } from "node:crypto";

import { deriveBuilderAppId } from "./names";
import { builderProvisionRequestSchema, builderProvisionResponseSchema } from "./contracts-schema";
import type { BuilderProvisionRequest, BuilderProvisionResponse } from "./contracts-schema";

export {
  builderProvisionProjectionSchema,
  builderProvisionRequestSchema,
  builderProvisionResponseSchema,
} from "./contracts-schema";
export {
  githubProvisionResultSchema,
  vercelProvisionDiagnosticSchema,
  vercelProvisionResultSchema,
} from "./contracts-schema";
export type {
  BuilderProvisionProjection,
  BuilderProvisionRequest,
  BuilderProvisionResponse,
  GitHubProvisionResult,
  VercelProvisionDiagnostic,
  VercelProvisionResult,
} from "./contracts-schema";

export function builderProvisionRequestDigest(input: BuilderProvisionRequest): string {
  const request = builderProvisionRequestSchema.parse(input);
  const digestInput = {
    appName: request.appName,
    providers: request.providers,
    repository: request.repository,
    requestId: request.requestId,
    version: request.version,
  };
  if (request.deploymentAccess !== undefined) {
    Object.assign(digestInput, { deploymentAccess: request.deploymentAccess });
  }
  return createHash("sha256").update(JSON.stringify(digestInput)).digest("hex");
}

export function initialBuilderProvisionResponse(
  input: BuilderProvisionRequest,
  now = new Date(),
): BuilderProvisionResponse {
  const request = builderProvisionRequestSchema.parse(input);
  const response = {
    appId: deriveBuilderAppId(request.appName),
    github:
      request.providers.githubInstallationId !== undefined &&
      request.providers.githubInstallationId !== ""
        ? { code: "provider_unavailable", retryable: true, status: "failed" }
        : { code: "not_selected", retryable: false, status: "skipped" },
    requestDigest: builderProvisionRequestDigest(request),
    requestId: request.requestId,
    status: "pending",
    updatedAt: now.toISOString(),
    vercel:
      request.providers.vercelInstallationId !== undefined &&
      request.providers.vercelInstallationId !== ""
        ? { code: "provider_unavailable", retryable: true, status: "failed" }
        : { code: "not_selected", retryable: false, status: "skipped" },
    version: 1,
  };
  if (request.deploymentAccess !== undefined) {
    Object.assign(response, { deploymentAccess: request.deploymentAccess });
  }
  return builderProvisionResponseSchema.parse(response);
}
