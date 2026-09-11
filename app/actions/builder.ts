"use server";

import { headers } from "next/headers";
import { z } from "zod";

import { readPreviewOAuthRuntimeConfig } from "@/lib/auth/preview-oauth-runtime";
import { getBuilderHandoffDeploymentHandler } from "@/lib/handoff/deployment";
import {
  type BuilderProvisionResponse,
  builderProvisionRequestSchema,
} from "@/lib/provisioning/contracts";
import { getBuilderProvisioningDeploymentHandler } from "@/lib/provisioning/deployment";
import { deriveBuilderAppId } from "@/lib/provisioning/names";

const handoffContinuationInputSchema = z
  .object({
    version: z.literal(1),
    requestId: z.string().uuid(),
    creationRequestId: z.string().uuid(),
    provisioningEnabled: z.boolean(),
    retryProvider: z.enum(["github", "vercel"]).optional(),
    form: z
      .object({
        appName: z.string().trim().min(1).max(120),
        repository: z
          .string()
          .trim()
          .min(1)
          .max(100)
          .regex(/^[A-Za-z0-9._-]+$/u),
        brief: z.string().trim().min(1).max(32_000),
        privateRepository: z.boolean(),
        buildDestination: z.enum(["web", "codex", "cursor"]),
        connections: z.array(z.string().trim().min(1).max(100)).max(50),
        githubInstallationId: z
          .string()
          .regex(/^[1-9][0-9]*$/u)
          .optional(),
        vercelInstallationId: z.string().min(1).max(256).optional(),
        modelId: z.string().min(1).max(100),
      })
      .strict(),
  })
  .strict();

export type BuilderHandoffContinuationInput = z.infer<
  typeof handoffContinuationInputSchema
>;

export type BuilderHandoffContinuationState =
  | {
      status: "ready";
      provisioning: BuilderProvisionResponse;
      handoff: { version: 1; handoffId: string; expiresAt: string };
    }
  | { status: "error" };

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
      | { error?: string }
      | undefined;
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
    })
  );
  return readJson(response, "provisioning_unavailable");
}

export async function reserveBuilderProvider(input: {
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
  const path = "/api/builder/provision?mode=reserve";
  const response = await getBuilderProvisioningDeploymentHandler(process.env)(
    new Request(requestUrl(path), {
      method: "POST",
      headers: await sameOriginHeaders("application/json"),
      body: JSON.stringify(input),
    })
  );
  return readJson(response, "provisioning_unavailable");
}

export async function readBuilderProviderProvisioning(requestId: string) {
  const path = `/api/builder/provision?requestId=${encodeURIComponent(requestId)}`;
  const response = await getBuilderProvisioningDeploymentHandler(process.env)(
    new Request(requestUrl(path), {
      headers: await sameOriginHeaders(),
      cache: "no-store",
    })
  );
  return readJson<BuilderProvisionResponse>(
    response,
    "provisioning_unavailable"
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
    })
  );
  return readJson<{
    version: 1;
    handoffId: string;
    expiresAt: string;
  }>(response, "handoff_unavailable");
}

function provisioningInput(
  input: BuilderHandoffContinuationInput,
  operation: "github" | "vercel"
) {
  return builderProvisionRequestSchema.parse({
    version: 1,
    requestId: input.requestId,
    operation,
    appName: input.form.appName,
    repository: {
      name: input.form.repository,
      private: input.form.privateRepository,
    },
    providers: {
      ...(input.form.githubInstallationId
        ? { githubInstallationId: input.form.githubInstallationId }
        : {}),
      ...(input.form.vercelInstallationId
        ? { vercelInstallationId: input.form.vercelInstallationId }
        : {}),
    },
  });
}

function unavailableProvisioning(
  input: BuilderHandoffContinuationInput,
  code: "feature_disabled" | "provider_unavailable"
): BuilderProvisionResponse {
  const result = (provider: "github" | "vercel") => {
    const selected =
      provider === "github"
        ? input.form.githubInstallationId !== undefined
        : input.form.vercelInstallationId !== undefined;
    if (!selected)
      return {
        status: "skipped" as const,
        code: "not_selected" as const,
        retryable: false,
      };
    if (code === "feature_disabled")
      return {
        status: "skipped" as const,
        code: "feature_disabled" as const,
        retryable: false,
      };
    return {
      status: "failed" as const,
      code: "provider_unavailable" as const,
      retryable: true,
    };
  };
  return {
    version: 1,
    requestId: input.requestId,
    requestDigest: "0".repeat(64),
    appId: deriveBuilderAppId(input.form.appName),
    status: "settled",
    github: result("github"),
    vercel: result("vercel"),
    updatedAt: new Date().toISOString(),
  };
}

async function createContinuationHandoff(
  input: BuilderHandoffContinuationInput,
  provisioning: BuilderProvisionResponse
) {
  return createBuilderHandoff({
    version: 1,
    creationRequestId: input.creationRequestId,
    destination: input.form.buildDestination === "cursor" ? "cursor" : "codex",
    ...(provisioning.requestDigest === "0".repeat(64)
      ? {}
      : { provisioningRequestId: provisioning.requestId }),
    appName: input.form.appName,
    repository: {
      name: input.form.repository,
      private: input.form.privateRepository,
    },
    brief: input.form.brief,
    modelId: input.form.modelId,
    connections: input.form.connections,
  });
}

/**
 * Executes the ordered provider continuation inside one authenticated Server
 * Action. Client leaves receive a serializable terminal state through
 * `useActionState`; they never coordinate provider mutations themselves.
 */
export async function continueBuilderHandoff(
  _previous: BuilderHandoffContinuationState | undefined,
  untrustedInput: BuilderHandoffContinuationInput
): Promise<BuilderHandoffContinuationState> {
  const parsed = handoffContinuationInputSchema.safeParse(untrustedInput);
  if (!parsed.success) return { status: "error" };
  const input = parsed.data;

  try {
    let provisioning = unavailableProvisioning(
      input,
      input.provisioningEnabled ? "provider_unavailable" : "feature_disabled"
    );

    if (input.provisioningEnabled && input.retryProvider) {
      provisioning = await provisionBuilderProvider(
        provisioningInput(input, input.retryProvider)
      );
    } else if (input.provisioningEnabled) {
      if (input.form.githubInstallationId) {
        try {
          await reserveBuilderProvider(provisioningInput(input, "github"));
          provisioning = await provisionBuilderProvider(
            provisioningInput(input, "github")
          );
        } catch {
          if (input.form.vercelInstallationId)
            provisioning = {
              ...provisioning,
              vercel: {
                status: "skipped",
                code: "github_required",
                retryable: false,
              },
            };
        }
      }
      if (
        input.form.vercelInstallationId &&
        (!input.form.githubInstallationId ||
          provisioning.github.status === "succeeded")
      ) {
        try {
          await reserveBuilderProvider(provisioningInput(input, "vercel"));
          provisioning = await provisionBuilderProvider(
            provisioningInput(input, "vercel")
          );
        } catch {
          // Preserve the most recent durable provisioning snapshot. The retry
          // action can safely continue from this idempotent request later.
        }
      }
    }

    const handoff = await createContinuationHandoff(input, provisioning);
    return { status: "ready", provisioning, handoff };
  } catch {
    return { status: "error" };
  }
}
