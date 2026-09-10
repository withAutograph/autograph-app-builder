"use server";

import { headers } from "next/headers";

import { readPreviewOAuthRuntimeConfig } from "@/lib/auth/preview-oauth-runtime";
import { getBuilderHandoffDeploymentHandler } from "@/lib/handoff/deployment";
import { getBuilderProvisioningDeploymentHandler } from "@/lib/provisioning/deployment";
import type { BuilderProvisionResponse } from "@/lib/provisioning/contracts";

function requestUrl(path: string) {
  const preview = readPreviewOAuthRuntimeConfig(process.env);
  return `${new URL(preview.issuer).origin}${path}`;
}

async function sameOriginHeaders(contentType?: string) {
  const incoming = await headers();
  const forwarded = new Headers(incoming);
  const origin = new URL(requestUrl("/")).origin;
  forwarded.set("origin", origin);
  if (contentType) forwarded.set("content-type", contentType);
  return forwarded;
}

async function readJson<T>(response: Response, fallback: string): Promise<T> {
  if (!response.ok) {
    const payload = (await response.json().catch(() => undefined)) as
      { error?: string } | undefined;
    throw new Error(payload?.error ?? fallback);
  }
  return (await response.json()) as T;
}

export async function provisionBuilderProvider(input: {
  version: 1;
  requestId: string;
  operation: "github" | "vercel";
  appName: string;
  repository: { name: string; private: boolean };
  providers: {
    githubInstallationId?: string;
    vercelInstallationId?: string;
  };
}): Promise<BuilderProvisionResponse> {
  const path = "/api/builder/provision";
  const response = await getBuilderProvisioningDeploymentHandler(process.env)(
    new Request(requestUrl(path), {
      method: "POST",
      headers: await sameOriginHeaders("application/json"),
      body: JSON.stringify(input),
    }),
  );
  return readJson(response, "provisioning_unavailable");
}

export async function readBuilderProviderProvisioning(requestId: string) {
  const path = `/api/builder/provision?requestId=${encodeURIComponent(requestId)}`;
  const response = await getBuilderProvisioningDeploymentHandler(process.env)(
    new Request(requestUrl(path), {
      headers: await sameOriginHeaders(),
      cache: "no-store",
    }),
  );
  return readJson<BuilderProvisionResponse>(
    response,
    "provisioning_unavailable",
  );
}

export async function createBuilderHandoff(input: {
  version: 1;
  creationRequestId: string;
  destination: "codex" | "cursor";
  provisioningRequestId?: string;
  appName: string;
  repository: { name: string; private: boolean };
  brief: string;
  modelId: string;
  connections: string[];
}) {
  const path = "/api/builder/handoffs";
  const response = await getBuilderHandoffDeploymentHandler(process.env)(
    new Request(requestUrl(path), {
      method: "POST",
      headers: await sameOriginHeaders("application/json"),
      body: JSON.stringify(input),
    }),
  );
  return readJson<{
    version: 1;
    handoffId: string;
    expiresAt: string;
  }>(response, "handoff_unavailable");
}
