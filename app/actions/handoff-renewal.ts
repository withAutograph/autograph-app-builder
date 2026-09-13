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
    creationRequestId: z.string().uuid(),
    handoffId: z.string().uuid(),
  })
  .strict();

const renewedHandoffSchema = z
  .object({
    expiresAt: z.string().datetime(),
    handoffId: z.string().uuid(),
    version: z.literal(1),
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

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function requestUrl(path: string) {
  const preview = readPreviewOAuthRuntimeConfig(process.env);
  return `${new URL(preview.issuer).origin}${path}`;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
async function sameOriginHeaders() {
  const incoming = await headers();
  const forwarded = new Headers(incoming);
  forwarded.set("origin", new URL(requestUrl("/")).origin);
  forwarded.set("content-type", "application/json");
  return forwarded;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function toControlData(
  value: Awaited<ReturnType<typeof getBuilderHandoffPageData>>,
): HandoffControlData | undefined {
  if (!value) return;
  return {
    cursorInstallReady: value.cursorInstallReady,
    destination: value.destination,
    expiresAt: value.expiresAt,
    handoffId: value.handoffId,
    mcpUrl: value.mcpUrl,
    status: value.status,
    version: 1 as const,
  };
}

/**
 * Authenticated, idempotent renewal for the visible handoff route. The action
 * reuses the deployment handler so the request is still authorized solely by
 * the current Better Auth session and tenant authority, never client input.
 */
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
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
          body: JSON.stringify({ creationRequestId: input.creationRequestId }),
          headers: await sameOriginHeaders(),
          method: "POST",
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
        handoffId: renewed.data.handoffId,
        headers: await headers(),
      }),
    );
    if (!handoff) return { status: "unavailable" };
    refresh();
    return { handoff, status: "renewed" };
  } catch {
    return { status: "error" };
  }
}
