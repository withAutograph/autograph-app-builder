"use server";

import { refresh } from "next/cache";
import { headers } from "next/headers";
import { z } from "zod";

import { readPreviewOAuthRuntimeConfig } from "@/lib/auth/preview-oauth-runtime";
import { getAuthenticatedBuilderDraftContext } from "@/lib/builder-drafts/deployment";
import {
  getBuilderHandoffDeploymentHandler,
  getBuilderHandoffPageData,
} from "@/lib/handoff/deployment";
import { getBuilderProvisioningDeploymentHandler } from "@/lib/provisioning/deployment";
import { builderProvisionRequestSchema } from "@/lib/provisioning/contracts";
import type { BuilderProvisionResponse } from "@/lib/provisioning/contracts";
import { sourceCandidateReferenceSchema } from "@/lib/handoff/application-source-contract";
import {
  readAuthenticatedSourceUploadContext,
  withSourceUploadAuthority,
} from "@/lib/handoff/source-upload-deployment";
import { deriveBuilderAppId } from "@/lib/provisioning/names";

const resolvedHandoffContinuationInputSchema = z.strictObject({
  creationRequestId: z.uuid(),
  form: z.strictObject({
    appName: z.string().trim().min(1).max(120),
    brief: z.string().trim().min(1).max(32_000),
    buildDestination: z.enum(["web", "codex", "cursor"]),
    connections: z.array(z.string().trim().min(1).max(100)).max(50),
    githubInstallationId: z
      .string()
      .regex(/^[1-9][0-9]*$/u)
      .optional(),
    modelId: z.string().min(1).max(100),
    privateRepository: z.boolean(),
    repository: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z0-9._-]+$/u),
    sourceCandidate: sourceCandidateReferenceSchema.optional(),
    vercelInstallationId: z.string().min(1).max(256).optional(),
  }),
  provisioningEnabled: z.boolean(),
  requestId: z.uuid(),
  retryProvider: z.enum(["github", "vercel"]).optional(),
  version: z.literal(1),
});

const handoffContinuationInputSchema = resolvedHandoffContinuationInputSchema
  .omit({ form: true })
  .extend({
    draftCheckpoint: z.strictObject({ draftId: z.uuid(), revision: z.number().int().positive() }),
  });

export type BuilderHandoffContinuationInput = z.infer<typeof handoffContinuationInputSchema>;
type ResolvedHandoffContinuationInput = z.infer<typeof resolvedHandoffContinuationInputSchema>;

export type BuilderHandoffContinuationState =
  | {
      status: "ready";
      provisioning: BuilderProvisionResponse;
      handoff: { version: 1; handoffId: string; expiresAt: string };
    }
  | { status: "error" };

const handoffProvisioningContinuationInputSchema = z.strictObject({
  handoffId: z.uuid(),
  retryProvider: z.enum(["github", "vercel"]).optional(),
});

export type HandoffProvisioningContinuationState = { status: "updated" } | { status: "error" };

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function requestUrl(path: string) {
  const preview = readPreviewOAuthRuntimeConfig(process.env);
  return `${new URL(preview.issuer).origin}${path}`;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
async function sameOriginHeaders(contentType?: string) {
  const incoming = await headers();
  const forwarded = new Headers(incoming);
  const { origin } = new URL(requestUrl("/"));
  forwarded.set("origin", origin);
  if (contentType !== undefined && contentType.length > 0) {
    forwarded.set("content-type", contentType);
  }
  return forwarded;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
async function readJson<T>(response: Response, fallback: string): Promise<T> {
  if (!response.ok) {
    let payload: { error?: string } | undefined;
    try {
      // SAFETY: JSON is treated as unknown and validated by errorPayloadSchema below.
      const parsed = (await response.json()) as unknown;
      const errorPayloadSchema = z.object({ error: z.string().optional() });
      const errorPayload = errorPayloadSchema.safeParse(parsed);
      if (errorPayload.success) {
        payload = errorPayload.data;
      }
    } catch {
      // Invalid JSON has no error payload.
    }
    throw new Error(payload?.error ?? fallback);
  }
  const parsed: unknown = await response.json();
  const result = await z.custom<T>().safeParseAsync(parsed);
  if (!result.success) {
    throw new Error(fallback);
  }
  return result.data;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export async function provisionBuilderProvider(input: {
  version: 1;
  requestId: string;
  operation: "github" | "vercel";
  appName: string;
  deploymentAccess?: "public-app";
  repository: { name: string; private: boolean };
  providers: {
    githubInstallationId?: string;
    vercelInstallationId?: string;
  };
}): Promise<BuilderProvisionResponse> {
  const path = "/api/builder/provision";
  const response = await getBuilderProvisioningDeploymentHandler(process.env)(
    new Request(requestUrl(path), {
      body: JSON.stringify(input),
      headers: await sameOriginHeaders("application/json"),
      method: "POST",
    }),
  );
  return await readJson(response, "provisioning_unavailable");
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
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
      body: JSON.stringify(input),
      headers: await sameOriginHeaders("application/json"),
      method: "POST",
    }),
  );
  return await readJson(response, "provisioning_unavailable");
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export async function readBuilderProviderProvisioning(requestId: string) {
  const path = `/api/builder/provision?requestId=${encodeURIComponent(requestId)}`;
  const response = await getBuilderProvisioningDeploymentHandler(process.env)(
    new Request(requestUrl(path), {
      cache: "no-store",
      headers: await sameOriginHeaders(),
    }),
  );
  return await readJson<BuilderProvisionResponse>(response, "provisioning_unavailable");
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
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
  sourceCandidate?: z.infer<typeof sourceCandidateReferenceSchema>;
}) {
  const path = "/api/builder/handoffs";
  const response = await getBuilderHandoffDeploymentHandler(process.env)(
    new Request(requestUrl(path), {
      body: JSON.stringify(input),
      headers: await sameOriginHeaders("application/json"),
      method: "POST",
    }),
  );
  return await readJson<{
    version: 1;
    handoffId: string;
    expiresAt: string;
  }>(response, "handoff_unavailable");
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function provisioningInput(
  input: ResolvedHandoffContinuationInput,
  operation: "github" | "vercel",
) {
  const providers: z.infer<typeof builderProvisionRequestSchema>["providers"] = {
    githubInstallationId: input.form.githubInstallationId ?? undefined,
    vercelInstallationId: input.form.vercelInstallationId ?? undefined,
  };
  return builderProvisionRequestSchema.parse({
    appName: input.form.sourceCandidate?.appId ?? input.form.appName,
    deploymentAccess: "public-app",
    operation,
    providers,
    repository: {
      name: input.form.repository,
      private: input.form.privateRepository,
    },
    requestId: input.requestId,
    version: 1,
  });
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function unavailableProvisioning(
  input: ResolvedHandoffContinuationInput,
  code: "feature_disabled" | "provider_unavailable",
): BuilderProvisionResponse {
  const result = (provider: "github" | "vercel") => {
    const selected =
      provider === "github"
        ? input.form.githubInstallationId !== undefined
        : input.form.vercelInstallationId !== undefined;
    if (!selected) {
      return {
        code: "not_selected" as const,
        retryable: false,
        status: "skipped" as const,
      };
    }
    if (code === "feature_disabled") {
      return {
        code: "feature_disabled" as const,
        retryable: false,
        status: "skipped" as const,
      };
    }
    return {
      code: "provider_unavailable" as const,
      retryable: true,
      status: "failed" as const,
    };
  };
  return {
    appId: input.form.sourceCandidate?.appId ?? deriveBuilderAppId(input.form.appName),
    github: result("github"),
    requestDigest: "0".repeat(64),
    requestId: input.requestId,
    status: "settled",
    updatedAt: new Date().toISOString(),
    vercel: result("vercel"),
    version: 1,
  };
}

// eslint-disable-next-line eslint/func-style, eslint/require-await -- Preserve function declaration hoisting and initialization timing.
async function createContinuationHandoff(
  input: ResolvedHandoffContinuationInput,
  provisioning: BuilderProvisionResponse,
) {
  return createBuilderHandoff({
    creationRequestId: input.creationRequestId,
    destination: input.form.buildDestination === "cursor" ? "cursor" : "codex",
    version: 1,
    ...(provisioning.requestDigest === "0".repeat(64)
      ? {}
      : { provisioningRequestId: provisioning.requestId }),
    appName: input.form.appName,
    ...(input.form.sourceCandidate === undefined
      ? {}
      : { sourceCandidate: input.form.sourceCandidate }),
    brief: input.form.brief,
    connections: input.form.connections,
    modelId: input.form.modelId,
    repository: {
      name: input.form.repository,
      private: input.form.privateRepository,
    },
  });
}

/**
 * Executes the ordered provider continuation inside one authenticated Server
 * Action. Client leaves receive a serializable terminal state through
 * `useActionState`; they never coordinate provider mutations themselves.
 */
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export async function continueBuilderHandoff(
  _previous: BuilderHandoffContinuationState | undefined,
  untrustedInput: BuilderHandoffContinuationInput,
): Promise<BuilderHandoffContinuationState> {
  const parsed = handoffContinuationInputSchema.safeParse(untrustedInput);
  if (!parsed.success) {
    return { status: "error" };
  }
  try {
    const context = await getAuthenticatedBuilderDraftContext({
      environment: process.env,
      headers: await headers(),
    });
    if (!context) {
      return { status: "error" };
    }
    const { draftCheckpoint, ...request } = parsed.data;
    const draft = await context.drafts.read(context.authority, draftCheckpoint.draftId);
    // A newer device revision must never be silently provisioned with an older
    // device's form. The client refreshes that revision before trying again.
    if (!draft || draft.revision !== draftCheckpoint.revision) {
      return { status: "error" };
    }
    const input = resolvedHandoffContinuationInputSchema.parse({
      ...request,
      form: draft.record.draft.form,
    });
    if (input.form.sourceCandidate !== undefined) {
      const reference = input.form.sourceCandidate;
      await withSourceUploadAuthority(
        async () =>
          await readAuthenticatedSourceUploadContext({
            environment: process.env,
            headers: await headers(),
          }),
        async ({ authority, store }) => {
          if (
            [
              authority.issuer,
              authority.audience,
              authority.workspaceId,
              authority.ownerUserId,
            ].join("\0") !==
            [
              context.authority.issuer,
              context.authority.audience,
              context.authority.workspaceId,
              context.authority.ownerUserId,
            ].join("\0")
          ) {
            throw new Error("source_upload_authentication_required");
          }
          const artifact = await store.readCompleted({ authority, reference });
          if (artifact === undefined || artifact.manifest.appId !== reference.appId) {
            throw new Error("source_upload_incomplete");
          }
        },
      );
    }
    let provisioning = unavailableProvisioning(
      input,
      input.provisioningEnabled ? "provider_unavailable" : "feature_disabled",
    );

    if (input.provisioningEnabled) {
      const operation = input.form.githubInstallationId === undefined ? "vercel" : "github";
      if (
        (operation === "github" && input.form.githubInstallationId !== undefined) ||
        (operation === "vercel" && input.form.vercelInstallationId !== undefined)
      ) {
        // Reserve once, before the handoff exists. The visible handoff route
        // subsequently owns lease-safe provider continuation.
        provisioning = await reserveBuilderProvider(provisioningInput(input, operation));
      }
    }

    const handoff = await createContinuationHandoff(input, provisioning);
    // Persistence precedes reset. Conditional archival leaves a newer device
    // edit active if it completed while this durable handoff was being created.
    await context.drafts.archive(context.authority, draft.draftId, draft.revision);
    return { handoff, provisioning, status: "ready" };
  } catch {
    return { status: "error" };
  }
}

/**
 * Continues the durable provisioning record from its visible handoff route.
 * The journal lease prevents concurrent tabs or devices from running the same
 * provider work, and `refresh()` folds the new read model into the action
 * response without a client-side status fetch.
 */
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export async function continueHandoffProvisioning(
  _previous: HandoffProvisioningContinuationState | undefined,
  untrustedInput: { handoffId: string; retryProvider?: "github" | "vercel" },
): Promise<HandoffProvisioningContinuationState> {
  const parsed = handoffProvisioningContinuationInputSchema.safeParse(untrustedInput);
  if (!parsed.success) {
    return { status: "error" };
  }
  try {
    const data = await getBuilderHandoffPageData({
      environment: process.env,
      handoffId: parsed.data.handoffId,
      headers: await headers(),
    });
    const requestId = data?.intent.provisioningRequestId;
    const providers = data?.intent.providers;
    if (data === undefined || requestId === undefined || providers === undefined) {
      return { status: "error" };
    }

    const run = async (operation: "github" | "vercel") => {
      const selected =
        operation === "github" ? providers.githubInstallationId : providers.vercelInstallationId;
      if (selected === undefined) {
        return;
      }
      const provisionInput: Parameters<typeof provisionBuilderProvider>[0] = {
        appName: data.intent.appName,
        operation,
        providers,
        repository: {
          name: data.intent.repository.requestedName,
          private: data.intent.repository.private,
        },
        requestId,
        version: 1,
      };
      if (data.intent.provisioning?.deploymentAccess !== undefined) {
        provisionInput.deploymentAccess = data.intent.provisioning.deploymentAccess;
      }
      await provisionBuilderProvider(provisionInput);
    };

    if (parsed.data.retryProvider) {
      await run(parsed.data.retryProvider);
    } else {
      if (providers.githubInstallationId !== undefined) {
        await run("github");
      }
      // The Vercel operation durably records `github_required` when GitHub
      // has not succeeded, so the journal settles instead of leaving an
      // indefinite pending handoff. A later GitHub retry safely re-runs it.
      if (providers.vercelInstallationId !== undefined) {
        await run("vercel");
      }
    }
    refresh();
    return { status: "updated" };
  } catch {
    return { status: "error" };
  }
}
