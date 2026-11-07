import { createHash } from "node:crypto";

import { deriveBuilderAppId } from "./names";
import { builderProvisionRequestSchema, builderProvisionResponseSchema } from "./contracts-schema";
import type { BuilderProvisionRequest, BuilderProvisionResponse } from "./contracts-schema";

export {
  builderProvisionProjectionSchema,
  builderProvisionRequestSchema,
  builderProvisionResponseSchema,
  githubProvisionResultSchema,
  githubProvisionSuccessSchema,
  vercelProvisionDiagnosticSchema,
  vercelProvisionResultSchema,
  vercelProvisionSuccessSchema,
} from "./contracts-schema";
export type {
  BuilderProvisionProjection,
  BuilderProvisionRequest,
  BuilderProvisionResponse,
  GitHubProvisionResult,
  VercelProvisionDiagnostic,
  VercelProvisionResult,
} from "./contracts-schema";

const isSelected = (value: string | null | undefined) =>
  value !== undefined && value !== null && value !== "";

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function builderProvisionRequestDigest(input: BuilderProvisionRequest): string {
  const request = builderProvisionRequestSchema.parse(input);
  const hash = createHash("sha256");
  const digestPrefix = { appName: request.appName };
  const digestRequest =
    request.deploymentAccess === undefined
      ? digestPrefix
      : { ...digestPrefix, deploymentAccess: request.deploymentAccess };
  return hash
    .update(
      JSON.stringify({
        ...digestRequest,
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
  const responsePrefix = { appId: deriveBuilderAppId(request.appName) };
  const response =
    request.deploymentAccess === undefined
      ? responsePrefix
      : { ...responsePrefix, deploymentAccess: request.deploymentAccess };
  return builderProvisionResponseSchema.parse({
    ...response,
    github: isSelected(request.providers.githubInstallationId)
      ? { code: "provider_unavailable", retryable: true, status: "failed" }
      : { code: "not_selected", retryable: false, status: "skipped" },
    requestDigest: builderProvisionRequestDigest(request),
    requestId: request.requestId,
    status: "pending",
    updatedAt: now.toISOString(),
    vercel: isSelected(request.providers.vercelInstallationId)
      ? { code: "provider_unavailable", retryable: true, status: "failed" }
      : { code: "not_selected", retryable: false, status: "skipped" },
    version: 1,
  });
}
