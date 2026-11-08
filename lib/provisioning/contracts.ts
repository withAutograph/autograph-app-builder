import { createHash } from "node:crypto";

import { deriveBuilderAppId } from "./names";
import { builderProvisionRequestSchema, builderProvisionResponseSchema } from "./contracts-schema";
import type { BuilderProvisionRequest, BuilderProvisionResponse } from "./contracts-schema";

export * from "./contracts-schema";

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function builderProvisionRequestDigest(input: BuilderProvisionRequest): string {
  const request = builderProvisionRequestSchema.parse(input);
  const hash = createHash("sha256");
  const update = hash.update.bind(hash);
  const { stringify } = JSON;
  const prefix: Pick<BuilderProvisionRequest, "appName" | "deploymentAccess"> = {
    appName: request.appName,
  };
  if (request.deploymentAccess !== undefined) {
    prefix.deploymentAccess = request.deploymentAccess;
  }
  return update(
    stringify({
      ...prefix,
      providers: request.providers,
      repository: request.repository,
      requestId: request.requestId,
      version: request.version,
    }),
  ).digest("hex");
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function initialBuilderProvisionResponse(
  input: BuilderProvisionRequest,
  now = new Date(),
): BuilderProvisionResponse {
  const request = builderProvisionRequestSchema.parse(input);
  const parse = builderProvisionResponseSchema.parse.bind(builderProvisionResponseSchema);
  const prefix: Pick<BuilderProvisionResponse, "appId" | "deploymentAccess"> = {
    appId: deriveBuilderAppId(request.appName),
  };
  if (request.deploymentAccess !== undefined) {
    prefix.deploymentAccess = request.deploymentAccess;
  }
  return parse({
    ...prefix,
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
