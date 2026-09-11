import { createHmac, timingSafeEqual } from "node:crypto";

import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { z } from "zod";

import {
  hostedGitHubInstallationBindings,
  hostedGitHubInstallations,
  hostedGitHubUserCredentials,
} from "../db/schema";
import * as databaseSchema from "../db/schema";

type Database = PostgresJsDatabase<typeof databaseSchema>;

function verify(input: {
  body: Uint8Array;
  signature: string;
  secret: string;
}) {
  if (!/^sha256=[0-9a-f]{64}$/u.test(input.signature)) return false;
  const expected = `sha256=${createHmac("sha256", input.secret)
    .update(input.body)
    .digest("hex")}`;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(input.signature));
}

const installationEvent = z
  .object({
    action: z.enum(["deleted", "suspend", "unsuspend"]),
    installation: z.object({ id: z.number().int().positive() }).passthrough(),
  })
  .passthrough();
const authorizationEvent = z
  .object({
    action: z.literal("revoked"),
    sender: z.object({ id: z.number().int().positive() }).passthrough(),
  })
  .passthrough();

export function createGitHubProvisioningWebhookHandler(input: {
  database: Database;
  secret: string;
  now?: () => number;
}) {
  const secret = z.string().min(32).max(512).parse(input.secret);
  const now = input.now ?? Date.now;
  return async (request: Request) => {
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const declaredLength = request.headers.get("content-length");
    if (
      declaredLength &&
      (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > 1024 * 1024)
    )
      return new Response(null, { status: 413 });
    const body = new Uint8Array(await request.arrayBuffer());
    if (
      body.byteLength > 1024 * 1024 ||
      !verify({
        body,
        signature: request.headers.get("x-hub-signature-256") ?? "",
        secret,
      })
    )
      return new Response(null, { status: 401 });
    const event = request.headers.get("x-github-event");
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(body));
    } catch {
      return new Response(null, { status: 400 });
    }
    const updatedAt = new Date(now());
    if (event === "github_app_authorization") {
      const parsed = authorizationEvent.safeParse(value);
      if (!parsed.success) return new Response(null, { status: 202 });
      await input.database
        .update(hostedGitHubUserCredentials)
        .set({ active: false, updatedAt })
        .where(
          eq(
            hostedGitHubUserCredentials.providerUserId,
            String(parsed.data.sender.id),
          ),
        );
    }
    if (event === "installation") {
      const parsed = installationEvent.safeParse(value);
      if (!parsed.success || parsed.data.action === "unsuspend")
        return new Response(null, { status: 202 });
      const installationId = String(parsed.data.installation.id);
      await input.database.transaction(async (transaction) => {
        await transaction
          .update(hostedGitHubInstallations)
          .set({ active: false, updatedAt })
          .where(eq(hostedGitHubInstallations.installationId, installationId));
        await transaction
          .update(hostedGitHubInstallationBindings)
          .set({ active: false, updatedAt })
          .where(
            eq(hostedGitHubInstallationBindings.installationId, installationId),
          );
      });
    }
    return new Response(null, {
      status: 202,
      headers: { "Cache-Control": "no-store" },
    });
  };
}
