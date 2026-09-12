"use server";

import { refresh } from "next/cache";
import { headers } from "next/headers";
import { z } from "zod";

import { readPreviewOAuthRuntimeConfig } from "@/lib/auth/preview-oauth-runtime";
import type { HandoffDestination } from "@/lib/handoff/client";
import {
  getBuilderHandoffPageData,
  getBuilderHandoffRenewDeploymentHandler,
} from "@/lib/handoff/deployment";

const renewalInputSchema = z
  .object({
    handoffId: z.string().uuid(),
    creationRequestId: z.string().uuid(),
  })
  .strict();

const renewedHandoffSchema = z
  .object({
    version: z.literal(1),
    handoffId: z.string().uuid(),
    expiresAt: z.string().datetime(),
  })
  .strict();

export interface HandoffControlData {
  version: 1;
  handoffId: string;
  expiresAt: string;
  status: "prepared" | "continued" | "expired";
  destination: HandoffDestination;
  cursorInstallReady: boolean;
  mcpUrl: string;
}

export type HandoffRenewalActionState =
  | { status: "renewed"; handoff: HandoffControlData }
  | { status: "sign-in" }
  | { status: "unavailable" }
  | { status: "error" };

function requestUrl(path: string) {
  const preview = readPreviewOAuthRuntimeConfig(process.env);
  return `${new URL(preview.issuer).origin}${path}`;
}

async function sameOriginHeaders() {
  const incoming = await headers();
  const forwarded = new Headers(incoming);
  forwarded.set("origin", new URL(requestUrl("/")).origin);
  forwarded.set("content-type", "application/json");
  return forwarded;
}

function toControlData(
  value: Awaited<ReturnType<typeof getBuilderHandoffPageData>>,
): HandoffControlData | undefined {
  if (!value) return undefined;
  return {
    version: 1 as const,
    handoffId: value.handoffId,
    expiresAt: value.expiresAt,
    status: value.status,
    destination: value.destination,
    cursorInstallReady: value.cursorInstallReady,
    mcpUrl: value.mcpUrl,
  };
}

/**
 * Authenticated, idempotent renewal for the visible handoff route. The action
 * reuses the deployment handler so the request is still authorized solely by
 * the current Better Auth session and tenant authority, never client input.
 */
export async function renewBuilderHandoff(
  _previous: HandoffRenewalActionState | undefined,
  untrustedInput: { handoffId: string; creationRequestId: string },
): Promise<HandoffRenewalActionState> {
  const parsed = renewalInputSchema.safeParse(untrustedInput);
  if (!parsed.success) return { status: "error" };

  const input = parsed.data;
  try {
    const response = await getBuilderHandoffRenewDeploymentHandler(process.env)(
      new Request(
        requestUrl(`/api/builder/handoffs/${encodeURIComponent(input.handoffId)}/renew`),
        {
          method: "POST",
          headers: await sameOriginHeaders(),
          body: JSON.stringify({ creationRequestId: input.creationRequestId }),
        },
      ),
      input.handoffId,
    );
    if (response.status === 401) return { status: "sign-in" };
    if (response.status === 403 || response.status === 404) return { status: "unavailable" };
    if (!response.ok) return { status: "error" };

    const renewed = renewedHandoffSchema.safeParse(await response.json());
    if (!renewed.success) return { status: "error" };
    const handoff = toControlData(
      await getBuilderHandoffPageData({
        environment: process.env,
        headers: await headers(),
        handoffId: renewed.data.handoffId,
      }),
    );
    if (!handoff) return { status: "unavailable" };
    refresh();
    return { status: "renewed", handoff };
  } catch {
    return { status: "error" };
  }
}
